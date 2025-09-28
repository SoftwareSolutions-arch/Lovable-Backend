import Deposit from "../models/Deposit.js";
import Account from "../models/Account.js";
import User from "../models/User.js";
import { getScope } from "../utils/scopeHelper.js";
import AuditLog from "../models/AuditLog.js";

// GET Deposits with role-based filtering
export const getDeposits = async (req, res, next) => {
  try {
    const scope = await getScope(req.user);

    let filter = {};
    if (!scope.isAll) {
      if (req.user.role === "Manager") {
        filter.collectedBy = { $in: scope.agents };
      } else if (req.user.role === "Agent") {
        filter.collectedBy = req.user._id;
      } else if (req.user.role === "User") {
        filter.userId = req.user._id;
      }
    }

    // 🔹 Date filters
    const { date, startDate, endDate } = req.query;
    if (date === "today") {
      const today = new Date();
      const startOfDay = new Date(today.setHours(0, 0, 0, 0));
      const endOfDay = new Date(today.setHours(23, 59, 59, 999));
      filter.date = { $gte: startOfDay, $lte: endOfDay };
    } else if (startDate && endDate) {
      filter.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    // ✅ Fetch deposits with account details
    const deposits = await Deposit.find(filter)
      .populate("accountId", "clientName accountNumber schemeType")
      .lean(); // plain objects, easier to transform

    // ✅ Flatten response
    const formattedDeposits = deposits.map((d) => ({
      _id: d._id,
      date: d.date,
      clientName: d.accountId?.clientName || null,
      accountNumber: d.accountId?.accountNumber || null,
      schemeType: d.accountId?.schemeType || d.schemeType,
      amount: d.amount,
      collectedBy: d.collectedBy,
      userId: d.userId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));

    res.json(formattedDeposits);
  } catch (err) {
    next(err);
  }
};



// CREATE Deposit with validations, balance update + audit log
export const createDeposit = async (req, res, next) => {
  try {
    const { accountId, userId, amount } = req.body;

    // Role check
    if (!["Admin", "Manager", "Agent"].includes(req.user.role)) {
      // audit fail
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ROLE_NOT_ALLOWED", accountId, userId, amount },
        performedBy: req.user?._id
      });
      res.status(403);
      throw new Error("Only Admin, Manager, or Agents can create deposits");
    }

    // Amount validation
    if (!amount || amount <= 0) {
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "INVALID_AMOUNT", accountId, userId, amount },
        performedBy: req.user?._id
      });
      res.status(400);
      throw new Error("Amount must be greater than 0");
    }

    // Validate account existence
    const account = await Account.findById(accountId);
    if (!account) {
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ACCOUNT_NOT_FOUND", accountId, userId, amount },
        performedBy: req.user?._id
      });
      res.status(404);
      throw new Error("Account not found");
    }

    // Validate userId matches account
    if (account.userId.toString() !== userId) {
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "USER_ACCOUNT_MISMATCH", accountId, userId, amount },
        performedBy: req.user?._id
      });
      res.status(400);
      throw new Error("User does not match account");
    }

    // Scope check: Agent can only deposit for own clients
    if (req.user.role === "Agent") {
      const client = await User.findById(userId);
      if (!client || client.assignedTo.toString() !== req.user._id.toString()) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "AGENT_SCOPE_VIOLATION", accountId, userId, amount },
          performedBy: req.user?._id
        });
        res.status(403);
        throw new Error("You can only deposit for your own clients");
      }
    }

    // Scope check: Manager -> clients under their agents
    if (req.user.role === "Manager") {
      const scope = await getScope(req.user);
      if (!scope.clients.includes(userId.toString())) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MANAGER_SCOPE_VIOLATION", accountId, userId, amount },
          performedBy: req.user?._id
        });
        res.status(403);
        throw new Error("You can only deposit for clients under your agents");
      }
    }

    // --------------------------
    // Prevent exceeding overall total payable
    // --------------------------
    const totalAllAgg = await Deposit.aggregate([
      { $match: { accountId: account._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const collectedAll = totalAllAgg.length ? totalAllAgg[0].total : 0;

    // account.totalPayableAmount must exist (controller/account creation ensures it)
    if (typeof account.totalPayableAmount !== "number") {
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "MISSING_TOTAL_PAYABLE", accountId, userId, amount },
        performedBy: req.user?._id
      });
      res.status(500);
      throw new Error("Account configuration invalid (missing totalPayableAmount)");
    }

    if (collectedAll + amount > account.totalPayableAmount) {
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: {
          reason: "TOTAL_PAYABLE_EXCEEDED",
          accountId,
          userId,
          amount,
          collectedAll,
          totalPayableAmount: account.totalPayableAmount
        },
        performedBy: req.user?._id
      });
      res.status(400);
      throw new Error(
        `Total payable exceeded: already ${collectedAll}, trying to add ${amount}, total allowed ${account.totalPayableAmount}`
      );
    }

    // --------------------------
    // PAYMENT MODE VALIDATIONS
    // --------------------------

    const now = new Date();

    // Block if already matured
    if (now >= account.maturityDate) {
      account.status = "Matured";
      await account.save();
      await AuditLog.create({
        action: "CREATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ACCOUNT_MATURED", accountId, userId, amount },
        performedBy: req.user?._id
      });
      res.status(400);
      throw new Error("Account has matured, no more deposits allowed");
    }

    if (account.paymentMode === "Yearly") {
      // require a yearlyAmount on account (from createAccount)
      const required = account.yearlyAmount ?? account.totalPayableAmount;
      if (account.isFullyPaid) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "YEARLY_ALREADY_PAID", accountId, userId, amount },
          performedBy: req.user?._id
        });
        res.status(400);
        throw new Error("Yearly account already paid in full");
      }
      if (amount !== required) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "YEARLY_AMOUNT_MISMATCH", accountId, userId, amount, required },
          performedBy: req.user?._id
        });
        res.status(400);
        throw new Error(`Yearly account requires a single payment of ${required}`);
      }
      // On success mark fully paid
      account.isFullyPaid = true;
      account.status = "OnTrack";
    }

    if (account.paymentMode === "Monthly") {
      const required = account.installmentAmount;
      if (!required || required <= 0) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MISSING_INSTALLMENT_AMOUNT", accountId, userId, amount },
          performedBy: req.user?._id
        });
        res.status(500);
        throw new Error("Account configuration invalid (missing installmentAmount)");
      }
      if (amount !== required) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MONTHLY_AMOUNT_MISMATCH", accountId, userId, amount, required },
          performedBy: req.user?._id
        });
        res.status(400);
        throw new Error(`Monthly account requires fixed installment of ${required}`);
      }

      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const endOfMonth = new Date(startOfMonth);
      endOfMonth.setMonth(endOfMonth.getMonth() + 1);

      const alreadyPaid = await Deposit.findOne({
        accountId: account._id,
        date: { $gte: startOfMonth, $lt: endOfMonth }
      });

      if (alreadyPaid) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MONTHLY_ALREADY_PAID", accountId, userId, amount },
          performedBy: req.user?._id
        });
        res.status(400);
        throw new Error("This month's installment already paid");
      }
    }

    if (account.paymentMode === "Daily") {
      if (!account.monthlyTarget || account.monthlyTarget <= 0) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MISSING_MONTHLY_TARGET", accountId, userId, amount },
          performedBy: req.user?._id
        });
        res.status(500);
        throw new Error("Daily account must have a monthlyTarget set");
      }

      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const endOfMonth = new Date(startOfMonth);
      endOfMonth.setMonth(endOfMonth.getMonth() + 1);

      const totalThisMonthAgg = await Deposit.aggregate([
        { $match: { accountId: account._id, date: { $gte: startOfMonth, $lt: endOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]);
      const collected = totalThisMonthAgg.length ? totalThisMonthAgg[0].total : 0;

      if (collected + amount > account.monthlyTarget) {
        await AuditLog.create({
          action: "CREATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: {
            reason: "DAILY_MONTHLY_TARGET_EXCEEDED",
            accountId,
            userId,
            amount,
            collected,
            monthlyTarget: account.monthlyTarget
          },
          performedBy: req.user?._id
        });
        res.status(400);
        throw new Error(
          `Daily account limit exceeded: monthly target is ${account.monthlyTarget}, already collected ${collected}`
        );
      }

      account.status = collected + amount >= account.monthlyTarget ? "OnTrack" : "Pending";
    }

    // --------------------------
    // CREATE DEPOSIT (all validations passed)
    // --------------------------
    const deposit = new Deposit({
      date: new Date(),
      accountId,
      userId,
      schemeType: account.schemeType, // authoritative source
      amount,
      collectedBy: req.user._id
    });

    await deposit.save();

    // Update account balance + status if needed
    account.balance += amount;
    if (account.balance > 0 && account.status === "Inactive") account.status = "Active";

    // If total collected equals totalPayableAmount -> optionally mark OnTrack or Closed (business decision)
    const afterTotalAgg = await Deposit.aggregate([
      { $match: { accountId: account._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const afterCollected = afterTotalAgg.length ? afterTotalAgg[0].total : 0;

    if (afterCollected >= account.totalPayableAmount) {
      // If fully collected earlier than maturity, mark OnTrack (or Closed per rules)
      account.status = "OnTrack";
      if (account.paymentMode === "Yearly") account.isFullyPaid = true;
    }

    await account.save();

    // Audit success
    await AuditLog.create({
      action: "CREATE_DEPOSIT",
      entityType: "Deposit",
      entityId: deposit._id,
      details: {
        amount,
        schemeType: account.schemeType,
        accountId: account._id,
        userId,
        accountBalance: account.balance,
        totalCollected: afterCollected,
        totalPayableAmount: account.totalPayableAmount
      },
      performedBy: req.user._id
    });

    res.status(201).json({ message: "Deposit created successfully", deposit });
  } catch (err) {
    next(err);
  }
};

// UPDATE Deposit (only Admin) with validations, balance update + audit log
export const updateDeposit = async (req, res, next) => {
  try {
    const { amount, date } = req.body; // we allow optional date update; schemeType will always be taken from account

    // Only Admin allowed (keep same behaviour)
    if (req.user.role !== "Admin") {
      await AuditLog.create({
        action: "UPDATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ROLE_NOT_ALLOWED", depositId: req.params.id, attemptedBy: req.user._id, payload: req.body },
        performedBy: req.user._id
      });
      res.status(403);
      throw new Error("Only Admin can update deposits");
    }

    // Find deposit
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) {
      await AuditLog.create({
        action: "UPDATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "DEPOSIT_NOT_FOUND", depositId: req.params.id, payload: req.body },
        performedBy: req.user._id
      });
      res.status(404);
      throw new Error("Deposit not found");
    }

    // Find account
    const account = await Account.findById(deposit.accountId);
    if (!account) {
      await AuditLog.create({
        action: "UPDATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ACCOUNT_NOT_FOUND", depositId: deposit._id, accountId: deposit.accountId },
        performedBy: req.user._id
      });
      res.status(404);
      throw new Error("Associated account not found");
    }

    // Validate amount if provided
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
      await AuditLog.create({
        action: "UPDATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "INVALID_AMOUNT", depositId: deposit._id, attemptedAmount: amount },
        performedBy: req.user._id
      });
      res.status(400);
      throw new Error("Amount must be a positive number");
    }

    // Ensure account has totalPayableAmount configured
    if (typeof account.totalPayableAmount !== "number") {
      await AuditLog.create({
        action: "UPDATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "MISSING_TOTAL_PAYABLE", accountId: account._id },
        performedBy: req.user._id
      });
      res.status(500);
      throw new Error("Account misconfigured: missing totalPayableAmount");
    }

    // Compute totals (current totals from DB)
    const totalAgg = await Deposit.aggregate([
      { $match: { accountId: account._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const collectedAll = totalAgg.length ? totalAgg[0].total : 0;
    const collectedExcludingThis = collectedAll - (deposit.amount || 0);

    // If changing amount, ensure overall total payable won't be exceeded
    const newAmount = amount !== undefined ? amount : deposit.amount;
    if (collectedExcludingThis + newAmount > account.totalPayableAmount) {
      await AuditLog.create({
        action: "UPDATE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: {
          reason: "TOTAL_PAYABLE_EXCEEDED",
          accountId: account._id,
          depositId: deposit._id,
          collectedExcludingThis,
          attemptedNewAmount: newAmount,
          totalPayableAmount: account.totalPayableAmount
        },
        performedBy: req.user._id
      });
      res.status(400);
      throw new Error(
        `Total payable exceeded: already ${collectedExcludingThis}, trying to set this deposit to ${newAmount}, total allowed ${account.totalPayableAmount}`
      );
    }

    // Payment-mode-specific validations
    const depositDate = date ? new Date(date) : new Date(deposit.date);
    const startOfMonth = new Date(depositDate.getFullYear(), depositDate.getMonth(), 1, 0, 0, 0, 0);
    const endOfMonth = new Date(startOfMonth);
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);

    if (account.paymentMode === "Yearly") {
      // For Yearly: require exactly the yearlyAmount (or totalPayableAmount)
      const required = account.yearlyAmount ?? account.totalPayableAmount;
      // If attempt changes amount, it must equal required
      if (newAmount !== required) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "YEARLY_AMOUNT_MISMATCH", accountId: account._id, required, attempted: newAmount },
          performedBy: req.user._id
        });
        res.status(400);
        throw new Error(`Yearly account deposit must equal ${required}`);
      }
      // It's okay to update the single yearly deposit so long as totals check passed above.
    }

    if (account.paymentMode === "Monthly") {
      const required = account.installmentAmount;
      if (!required || required <= 0) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MISSING_INSTALLMENT", accountId: account._id },
          performedBy: req.user._id
        });
        res.status(500);
        throw new Error("Account misconfigured: missing installmentAmount");
      }

      // amount (if provided) must equal installment
      if (newAmount !== required) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MONTHLY_AMOUNT_MISMATCH", accountId: account._id, required, attempted: newAmount },
          performedBy: req.user._id
        });
        res.status(400);
        throw new Error(`Monthly account deposit must equal installmentAmount (${required})`);
      }

      // ensure there will not be >1 deposits in that month after update (exclude current deposit)
      const depositsThisMonth = await Deposit.find({
        accountId: account._id,
        date: { $gte: startOfMonth, $lt: endOfMonth },
        _id: { $ne: deposit._id }
      });

      if (depositsThisMonth.length > 0) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MONTHLY_MULTIPLE_DEPOSITS", accountId: account._id, depositId: deposit._id },
          performedBy: req.user._id
        });
        res.status(400);
        throw new Error("Monthly account can only have one deposit per month");
      }
    }

    if (account.paymentMode === "Daily") {
      if (!account.monthlyTarget || account.monthlyTarget <= 0) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "MISSING_MONTHLY_TARGET", accountId: account._id },
          performedBy: req.user._id
        });
        res.status(500);
        throw new Error("Daily account misconfigured: missing monthlyTarget");
      }

      // compute collected this month excluding the current deposit
      const monthlyAgg = await Deposit.aggregate([
        {
          $match: {
            accountId: account._id,
            date: { $gte: startOfMonth, $lt: endOfMonth },
            _id: { $ne: deposit._id }
          }
        },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]);
      const collectedThisMonthExcl = monthlyAgg.length ? monthlyAgg[0].total : 0;
      const adjustedMonthTotal = collectedThisMonthExcl + newAmount;

      if (adjustedMonthTotal > account.monthlyTarget) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: {
            reason: "DAILY_MONTHLY_TARGET_EXCEEDED",
            accountId: account._id,
            depositId: deposit._id,
            collectedThisMonthExcl,
            attemptedNewAmount: newAmount,
            monthlyTarget: account.monthlyTarget
          },
          performedBy: req.user._id
        });

        res.status(400);
        throw new Error(
          `Daily account limit exceeded: monthly target is ${account.monthlyTarget}, would become ${adjustedMonthTotal}`
        );
      }
    }

    // --------------- All validations passed -> perform update ---------------
    const oldValues = {
      amount: deposit.amount,
      date: deposit.date,
      schemeType: deposit.schemeType
    };

    // update amount if provided
    if (amount !== undefined && amount !== deposit.amount) {
      deposit.amount = amount;
    }

    // optional date update (admin may want to change date)
    if (date) {
      const parsed = new Date(date);
      if (isNaN(parsed)) {
        await AuditLog.create({
          action: "UPDATE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: { reason: "INVALID_DATE", depositId: deposit._id, attemptedDate: date },
          performedBy: req.user._id
        });
        res.status(400);
        throw new Error("Invalid date format");
      }
      deposit.date = parsed;
    }

    // sync schemeType from account (authoritative)
    deposit.schemeType = account.schemeType;

    // save deposit
    await deposit.save();

    // Recalculate account's balance from DB sums (safer than incremental arithmetic)
    const afterAgg = await Deposit.aggregate([
      { $match: { accountId: account._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const afterCollected = afterAgg.length ? afterAgg[0].total : 0;
    account.balance = afterCollected;

    // Update account status / isFullyPaid logic
    if (afterCollected >= account.totalPayableAmount) {
      account.status = "OnTrack";
      if (account.paymentMode === "Yearly") account.isFullyPaid = true;
    } else {
      // For daily, maintain Pending/Active contract
      if (account.paymentMode === "Daily") {
        // compute this month's collected after update:
        const monthAgg = await Deposit.aggregate([
          {
            $match: {
              accountId: account._id,
              date: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1), $lt: new Date(new Date().getFullYear(), new Date().getMonth() + 1) }
            }
          },
          { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const monthCollected = monthAgg.length ? monthAgg[0].total : 0;
        account.status = monthCollected >= account.monthlyTarget ? "OnTrack" : "Pending";
      } else {
        // keep Active unless business rules say otherwise
        account.status = account.status === "Inactive" ? "Inactive" : "Active";
      }
      if (account.paymentMode === "Yearly") account.isFullyPaid = false;
    }

    await account.save();

    // Audit success - capture old/new
    await AuditLog.create({
      action: "UPDATE_DEPOSIT",
      entityType: "Deposit",
      entityId: deposit._id,
      details: {
        old: oldValues,
        new: {
          amount: deposit.amount,
          date: deposit.date,
          schemeType: deposit.schemeType
        },
        accountId: account._id,
        accountBalance: account.balance,
        totalCollected: afterCollected,
        totalPayableAmount: account.totalPayableAmount
      },
      performedBy: req.user._id
    });

    res.json({ message: "Deposit updated successfully", deposit });
  } catch (err) {
    next(err);
  }
};

// DELETE Deposit (only Admin) with validations, balance update + audit log
export const deleteDeposit = async (req, res, next) => {
  try {
    // Only Admin allowed
    if (req.user.role !== "Admin") {
      await AuditLog.create({
        action: "DELETE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ROLE_NOT_ALLOWED", depositId: req.params.id },
        performedBy: req.user._id
      });
      res.status(403);
      throw new Error("Only Admin can delete deposits");
    }

    // Find deposit
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) {
      await AuditLog.create({
        action: "DELETE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "DEPOSIT_NOT_FOUND", depositId: req.params.id },
        performedBy: req.user._id
      });
      res.status(404);
      throw new Error("Deposit not found");
    }

    // Find account
    const account = await Account.findById(deposit.accountId);
    if (!account) {
      await AuditLog.create({
        action: "DELETE_DEPOSIT_FAILED",
        entityType: "DepositAttempt",
        details: { reason: "ACCOUNT_NOT_FOUND", depositId: deposit._id, accountId: deposit.accountId },
        performedBy: req.user._id
      });
      res.status(404);
      throw new Error("Associated account not found");
    }

    // Get current totals for the account
    const totalAgg = await Deposit.aggregate([
      { $match: { accountId: account._id } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const collectedAll = totalAgg.length ? totalAgg[0].total : 0;
    const newCollected = collectedAll - deposit.amount;

    // --- PAYMENT MODE VALIDATIONS ---
    if (account.paymentMode === "Yearly") {
      const depositCount = await Deposit.countDocuments({ accountId: account._id });
      if (depositCount === 1) {
        await AuditLog.create({
          action: "DELETE_DEPOSIT_FAILED",
          entityType: "DepositAttempt",
          details: {
            reason: "CANNOT_DELETE_ONLY_YEARLY_DEPOSIT",
            accountId: account._id,
            depositId: deposit._id
          },
          performedBy: req.user._id
        });
        res.status(400);
        throw new Error("Cannot delete the only yearly deposit — account would become invalid");
      }
      // If we delete a yearly deposit (but not the only one), mark not fully paid if totals drop below payable
      if (account.isFullyPaid && newCollected < (account.totalPayableAmount || account.yearlyAmount || 0)) {
        account.isFullyPaid = false;
      }
    }

    if (account.paymentMode === "Monthly") {
      // If this is the only deposit in that month, we'll mark status Pending/Inactive afterwards
      // handled below after recomputing totals.
    }

    if (account.paymentMode === "Daily") {
      // monthly status recalculation done below
    }

    // --- UPDATE ACCOUNT BALANCE (recompute from DB for safety) ---
    const updatedTotalAgg = await Deposit.aggregate([
      { $match: { accountId: account._id, _id: { $ne: deposit._id } } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const updatedCollected = updatedTotalAgg.length ? updatedTotalAgg[0].total : 0;
    account.balance = Math.max(0, updatedCollected);

    // --- UPDATE STATUS & isFullyPaid ---
    // If totalPayableAmount exists, use it. Otherwise fallback to yearlyAmount.
    const totalPayable = account.totalPayableAmount ?? account.yearlyAmount ?? null;

    if (totalPayable !== null && updatedCollected >= totalPayable) {
      account.status = "OnTrack";
      if (account.paymentMode === "Yearly") account.isFullyPaid = true;
    } else {
      // Monthly: check if any deposit remains in the same month (excluding this one)
      if (account.paymentMode === "Monthly") {
        const startOfMonth = new Date(deposit.date.getFullYear(), deposit.date.getMonth(), 1, 0, 0, 0, 0);
        const endOfMonth = new Date(startOfMonth);
        endOfMonth.setMonth(endOfMonth.getMonth() + 1);

        const otherThisMonth = await Deposit.countDocuments({
          accountId: account._id,
          _id: { $ne: deposit._id },
          date: { $gte: startOfMonth, $lt: endOfMonth }
        });

        account.status = otherThisMonth > 0 ? "Active" : "Pending";
      } else if (account.paymentMode === "Daily") {
        const startOfMonth = new Date(deposit.date.getFullYear(), deposit.date.getMonth(), 1, 0, 0, 0, 0);
        const endOfMonth = new Date(startOfMonth);
        endOfMonth.setMonth(endOfMonth.getMonth() + 1);

        const monthAgg = await Deposit.aggregate([
          {
            $match: {
              accountId: account._id,
              _id: { $ne: deposit._id },
              date: { $gte: startOfMonth, $lt: endOfMonth }
            }
          },
          { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const collectedThisMonth = monthAgg.length ? monthAgg[0].total : 0;
        account.status = account.monthlyTarget && collectedThisMonth >= account.monthlyTarget ? "OnTrack" : "Pending";
      } else {
        // Default: mark inactive if no money left, otherwise keep Active
        account.status = account.balance > 0 ? "Active" : "Inactive";
      }

      if (account.paymentMode === "Yearly") {
        account.isFullyPaid = false;
      }
    }

    // --- AUDIT BEFORE DELETE (capture old values) ---
    await AuditLog.create({
      action: "DELETE_DEPOSIT_ATTEMPT",
      entityType: "Deposit",
      entityId: deposit._id,
      details: {
        reason: "DELETE_REQUEST",
        depositId: deposit._id,
        accountId: account._id,
        depositAmount: deposit.amount,
        oldCollectedTotal: collectedAll,
        expectedNewTotal: updatedCollected,
        paymentMode: account.paymentMode
      },
      performedBy: req.user._id
    });

    // --- Delete record ---
    await deposit.deleteOne();

    // --- Save account after delete adjustments ---
    await account.save();

    // --- AUDIT SUCCESS ---
    await AuditLog.create({
      action: "DELETE_DEPOSIT",
      entityType: "Deposit",
      entityId: deposit._id,
      details: {
        amount: deposit.amount,
        date: deposit.date,
        accountId: account._id,
        userId: deposit.userId,
        schemeType: deposit.schemeType,
        oldBalance: collectedAll,
        newBalance: account.balance,
        accountStatus: account.status
      },
      performedBy: req.user._id
    });

    res.json({
      message: "Deposit deleted successfully and account balance adjusted",
      accountBalance: account.balance,
      accountStatus: account.status
    });
  } catch (err) {
    next(err);
  }
};

// GET Deposits by Account Number
export const getDepositsByAccount = async (req, res, next) => {
  try {
    const { accountId } = req.params;

    const scope = await getScope(req.user);
    let filter = { accountId };

    if (!scope.isAll) {
      if (req.user.role === "Manager") {
        // Manager → only deposits collected by their agents
        filter.collectedBy = { $in: scope.agents };
      } else if (req.user.role === "Agent") {
        // Agent → only deposits they collected
        filter.collectedBy = req.user._id;
      } else if (req.user.role === "User") {
        // User → only their own deposits
        filter.userId = req.user._id;
      }
    }

    const deposits = await Deposit.find(filter)
      .populate("accountId", "accountNumber schemeType")
      .populate("collectedBy", "name email");

    if (!deposits || deposits.length === 0) {
      return res.status(404).json({ error: "No deposits found for this account" });
    }

    res.json(deposits);
  } catch (err) {
    next(err);
  }
};

// GET Deposits by Date Range with role and scope filtering
export const getDepositsByDateRange = async (req, res, next) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      res.status(400);
      throw new Error("Both 'from' and 'to' dates are required (YYYY-MM-DD)");
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate) || isNaN(toDate)) {
      res.status(400);
      throw new Error("Invalid date format. Use YYYY-MM-DD");
    }

    const scope = await getScope(req.user);

    let filter = {
      date: { $gte: from, $lte: to }
    };

    // Scope restrictions
    if (!scope.isAll) {
      if (req.user.role === "Manager") {
        filter.collectedBy = { $in: scope.agents };
      } else if (req.user.role === "Agent") {
        filter.collectedBy = req.user._id;
      } else if (req.user.role === "User") {
        filter.userId = req.user._id;
      }
    }

    const deposits = await Deposit.find(filter)
      .populate("accountId", "accountNumber schemeType")
      .populate("collectedBy", "name email");

    res.json({ count: deposits.length, deposits });
  } catch (err) {
    next(err);
  }
};

// BULK CREATE Deposits (Agent only, chunked by 10)
// Always uses today's date, not from user input
export const bulkCreateDeposits = async (req, res, next) => {
  try {
    const deposits = req.body.deposits;

    if (!Array.isArray(deposits) || deposits.length === 0) {
      return res.status(400).json({ message: "Deposits array required" });
    }

    // ✅ Role check - only Agent
    if (req.user.role !== "Agent") {
      return res
        .status(403)
        .json({ message: "Only Agents can perform bulk deposits" });
    }

    const success = [];
    const failed = [];
    const failureSummary = {};
    const now = new Date();

    // 🔹 Process in chunks of 10
    for (let i = 0; i < deposits.length; i += 10) {
      const chunk = deposits.slice(i, i + 10);

      for (const d of chunk) {
        let account;
        try {
          const { accountId, amount, collectedBy } = d;

          // ✅ Ensure collectedBy matches logged-in agent
          if (collectedBy !== req.user._id.toString()) {
            failed.push({ accountId, amount, error: "COLLECTED_BY_MISMATCH" });
            failureSummary["COLLECTED_BY_MISMATCH"] =
              (failureSummary["COLLECTED_BY_MISMATCH"] || 0) + 1;
            continue;
          }

          // ✅ Fetch account & resolve userId
          account = await Account.findById(accountId).populate("userId", "name");
          if (!account) {
            failed.push({ accountId, amount, error: "ACCOUNT_NOT_FOUND" });
            failureSummary["ACCOUNT_NOT_FOUND"] =
              (failureSummary["ACCOUNT_NOT_FOUND"] || 0) + 1;
            continue;
          }

          const userId = account.userId._id.toString();

          // ✅ Prevent duplicate deposits based on paymentMode
          let alreadyDeposited = null;
          if (account.paymentMode === "Daily") {
            const startOfDay = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
              0,
              0,
              0
            );
            const endOfDay = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
              23,
              59,
              59
            );
            alreadyDeposited = await Deposit.findOne({
              accountId: account._id,
              date: { $gte: startOfDay, $lte: endOfDay },
            });
          } else if (account.paymentMode === "Monthly") {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const endOfMonth = new Date(
              now.getFullYear(),
              now.getMonth() + 1,
              0,
              23,
              59,
              59
            );
            alreadyDeposited = await Deposit.findOne({
              accountId: account._id,
              date: { $gte: startOfMonth, $lte: endOfMonth },
            });
          } else if (account.paymentMode === "Yearly") {
            alreadyDeposited = await Deposit.findOne({ accountId: account._id });
          }

          if (alreadyDeposited) {
            const errMsg =
              account.paymentMode === "Daily"
                ? "Today’s deposit already recorded"
                : account.paymentMode === "Monthly"
                  ? "This month’s deposit already recorded"
                  : "Yearly account already paid in full";

            failed.push({
              accountId,
              accountNumber: account.accountNumber,
              clientName: account.userId?.name,
              amount,
              error: errMsg,
            });
            failureSummary[errMsg] = (failureSummary[errMsg] || 0) + 1;
            continue;
          }

          // ✅ Call createDeposit directly with resolved userId
          const reqClone = {
            body: { accountId, userId, amount },
            user: req.user,
          };

          const resClone = {
            statusCode: 200,
            jsonData: null,
            status(code) {
              this.statusCode = code;
              return this;
            },
            json(data) {
              this.jsonData = data;
              return this;
            },
          };

          await createDeposit(reqClone, resClone, (err) => {
            if (err) throw err;
          });

          if (resClone.statusCode === 201) {
            success.push({
              accountId,
              accountNumber: account.accountNumber,
              clientName: account.userId?.name,
              amount,
            });
          } else {
            const errMsg = resClone.jsonData?.message || "Unknown error";
            failed.push({
              accountId,
              accountNumber: account.accountNumber,
              clientName: account.userId?.name,
              amount,
              error: errMsg,
            });
            failureSummary[errMsg] = (failureSummary[errMsg] || 0) + 1;
          }
        } catch (err) {
          const errMsg = err.message || "Unknown error";
          failed.push({
            accountId: account?._id || d.accountId,
            accountNumber: account?.accountNumber,
            clientName: account?.userId?.name,
            amount: d.amount,
            error: errMsg,
          });
          failureSummary[errMsg] = (failureSummary[errMsg] || 0) + 1;
        }
      }
    }

    res.status(200).json({
      total: deposits.length,
      successCount: success.length,
      failedCount: failed.length,
      failedAccounts: failed,
      successAccounts: success,
      failureSummary,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/deposits/eligible
export const getEligibleAccountsForBulk = async (req, res, next) => {
  try {
    const scope = await getScope(req.user);
    const now = new Date();

    // 🔹 Base filter (accounts within user’s scope)
    let accountFilter = {};
    if (!scope.isAll) {
      if (req.user.role === "Manager") {
        accountFilter.assignedAgent = { $in: scope.agents };
      } else if (req.user.role === "Agent") {
        accountFilter.assignedAgent = req.user._id;
      } else if (req.user.role === "User") {
        accountFilter.userId = req.user._id;
      }
    }

    // 🔹 Fetch scoped accounts
    const accounts = await Account.find(accountFilter).populate("userId", "name");

    const eligible = [];

    for (const acc of accounts) {
      if (acc.status === "Matured" || acc.isFullyPaid) {
        continue; // ❌ skip matured or closed
      }

      let alreadyDeposited = null;

      if (acc.paymentMode === "Daily") {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        alreadyDeposited = await Deposit.findOne({
          accountId: acc._id,
          date: { $gte: startOfDay, $lte: endOfDay }
        });
      } else if (acc.paymentMode === "Monthly") {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        alreadyDeposited = await Deposit.findOne({
          accountId: acc._id,
          date: { $gte: startOfMonth, $lte: endOfMonth }
        });
      } else if (acc.paymentMode === "Yearly") {
        alreadyDeposited = await Deposit.findOne({
          accountId: acc._id
        });
      }

      if (!alreadyDeposited) {
        eligible.push(acc);
      }
    }

    res.json(eligible);
  } catch (err) {
    next(err);
  }
};