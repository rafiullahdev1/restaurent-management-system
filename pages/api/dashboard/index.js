import { requireAuth } from "../../../lib/apiAuth";
import {
  getDashboardStats,
  getTodayHourly,
  getRecentOrders,
  getTodayProductSales,
  getMonthlyProductSales,
} from "../../../repositories/reportRepository";
import {
  getTotalExpensesByDate,
  getTotalExpensesByRange,
} from "../../../repositories/expenseRepository";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res, ["admin", "manager"]);
  if (!user) return;

  // Compute today's date in the restaurant's local timezone (not the UTC server
  // clock). Without this, between midnight local time and midnight UTC the wrong
  // date string would be passed to expense queries, skewing the profit totals.
  const TZ         = process.env.DB_TIMEZONE || "UTC";
  const today      = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const [year, mo] = today.split("-");
  const monthStart = `${year}-${mo}-01`;

  try {
    const [stats, hourly, recentOrders, todaySales, monthlySales, todayExpenses, monthlyExpenses] = await Promise.all([
      getDashboardStats(),
      getTodayHourly(),
      getRecentOrders(10),
      getTodayProductSales(),
      getMonthlyProductSales(),
      getTotalExpensesByDate(today),
      getTotalExpensesByRange(monthStart, today),
    ]);

    // Attach all four financial figures to the stats object
    stats.today_expenses   = todayExpenses;
    stats.today_profit     = parseFloat(stats.today_revenue)   - todayExpenses;
    stats.monthly_expenses = monthlyExpenses;
    stats.monthly_profit   = parseFloat(stats.monthly_revenue) - monthlyExpenses;

    return res.status(200).json({ stats, hourly, recentOrders, todaySales, monthlySales });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(500).json({ error: "Failed to load dashboard data" });
  }
}
