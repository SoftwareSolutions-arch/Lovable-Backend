import express from "express";
import cors from "cors";
import morgan from "morgan";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import accountRoutes from "./routes/accountRoutes.js";
import depositRoutes from "./routes/depositRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { startMaturityCron } from "./cron/updateMaturedAccounts.js";
import { notFound, errorHandler } from "./middleware/errorMiddleware.js";
import { auditLogger } from "./middleware/auditMiddleware.js";
import auditRoutes from "./routes/auditRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

startMaturityCron();

// ✅ Keep-alive endpoint
app.get("/api/ping", (req, res) => {
  res.status(200).json({ message: "pong", timestamp: new Date().toISOString() });
});

// routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/deposits", depositRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/audit", auditRoutes);

app.use(notFound);
app.use(errorHandler);
app.use(auditLogger);

// generic error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

// ✅ Self-ping logic (every 5 min)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(async () => {
    try {
      const url = `${process.env.RENDER_EXTERNAL_URL}/api/ping`;
      const res = await fetch(url); // using global fetch from Node 18+
      console.log("Keep-alive ping:", url, res.status);
    } catch (err) {
      console.error("Keep-alive failed:", err.message);
    }
  }, 5 * 60); // 5 minutes
}


export default app;
