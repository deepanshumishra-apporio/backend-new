import { Router } from "express";
import * as adminInvestors from "../controllers/admin-investor.controller.ts";
import * as announcements from "../controllers/announcement.controller.ts";
import * as compliance from "../controllers/compliance.controller.ts";
import * as reports from "../controllers/report.controller.ts";
import * as support from "../controllers/admin-support.controller.ts";
import * as transactions from "../controllers/admin-transaction.controller.ts";
import * as roleAdmin from "../controllers/role-admin.controller.ts";
import * as staffAdmin from "../controllers/staff-admin.controller.ts";
import * as staffAuth from "../controllers/staff-auth.controller.ts";
import {
  authenticateStaff,
  requireAnyPermission,
  requireMfa,
  requireMfaPending,
  requirePasswordCurrent,
  requirePermission,
} from "../middleware/staff-auth.ts";
import { HttpError } from "../utils/http-error.ts";

/**
 * The admin portal's API, mounted ahead of the investor session gate.
 *
 * Sign-in lives under `/sessions` so the API's auth-tier rate limit (15/min
 * per IP) covers the password and MFA steps without a rule of its own.
 */
export const adminRouter = Router();

adminRouter.post("/sessions", staffAuth.login);

adminRouter.use(authenticateStaff);
adminRouter.get("/sessions/current", staffAuth.current);
adminRouter.delete("/sessions/current", staffAuth.logout);
adminRouter.post("/sessions/mfa/setup", requireMfaPending, staffAuth.mfaSetup);
adminRouter.post("/sessions/mfa/verify", requireMfaPending, staffAuth.mfaVerify);

adminRouter.use(requireMfa);
adminRouter.get("/me", staffAuth.me);
adminRouter.post("/me/password", staffAuth.changePassword);

adminRouter.use(requirePasswordCurrent);
adminRouter.get("/dashboard/summary", requirePermission("dashboard.read"), adminInvestors.summary);
adminRouter.get("/dashboard/signups", requirePermission("dashboard.read"), adminInvestors.signups);
adminRouter.get("/investors", requirePermission("investors.read"), adminInvestors.list);
adminRouter.get("/investors/:userId", requirePermission("investors.read"), adminInvestors.getOne);
adminRouter.get("/investors/:userId/items/:type/:itemId", requirePermission("investors.read"), adminInvestors.getItem);

const readReports = requirePermission("reports.read");
adminRouter.get("/reports", readReports, reports.list);
adminRouter.get("/reports/:key", readReports, reports.preview);
adminRouter.get("/reports/:key/export", readReports, reports.exportCsv);

const readTransactions = requirePermission("transactions.read");
adminRouter.get("/transactions/summary", readTransactions, transactions.summary);
adminRouter.get("/transactions", readTransactions, transactions.list);
adminRouter.get("/transactions/:orderId", readTransactions, transactions.getOne);
adminRouter.post("/transactions/:orderId/refresh", readTransactions, transactions.refresh);

const manageCompliance = requirePermission("compliance.manage");
adminRouter.get("/compliance/alerts", manageCompliance, compliance.list);
adminRouter.post("/compliance/scan", manageCompliance, compliance.scan);
adminRouter.get("/compliance/assignees", manageCompliance, compliance.assignees);
adminRouter.get("/compliance/alerts/:alertId", manageCompliance, compliance.getOne);
adminRouter.post("/compliance/alerts/:alertId/actions", manageCompliance, compliance.act);

const manageAnnouncements = requirePermission("announcements.manage");
adminRouter.get("/announcements", manageAnnouncements, announcements.list);
adminRouter.get("/announcements/reach", manageAnnouncements, announcements.reach);
adminRouter.post("/announcements", manageAnnouncements, announcements.create);
adminRouter.get("/announcements/:announcementId", manageAnnouncements, announcements.getOne);
adminRouter.put("/announcements/:announcementId", manageAnnouncements, announcements.update);
adminRouter.post("/announcements/:announcementId/actions", manageAnnouncements, announcements.act);

const manageSupport = requirePermission("support.manage");
adminRouter.get("/support/agents", manageSupport, support.agents);
adminRouter.get("/support/tickets", manageSupport, support.listTickets);
adminRouter.post("/support/tickets", manageSupport, support.createTicket);
adminRouter.get("/support/tickets/:ticketId", manageSupport, support.getTicket);
adminRouter.patch("/support/tickets/:ticketId", manageSupport, support.updateTicket);
adminRouter.post("/support/tickets/:ticketId/messages", manageSupport, support.replyToTicket);
adminRouter.get("/support/chats", manageSupport, support.listChats);
adminRouter.get("/support/chats/:chatId", manageSupport, support.getChat);
adminRouter.post("/support/chats/:chatId/take-over", manageSupport, support.takeOver);
adminRouter.post("/support/chats/:chatId/hand-back", manageSupport, support.handBack);
adminRouter.post("/support/chats/:chatId/messages", manageSupport, support.sendChatMessage);
adminRouter.post("/support/chats/:chatId/close", manageSupport, support.closeChat);
adminRouter.post("/support/chats/:chatId/escalate", manageSupport, support.escalateChat);

const manageStaff = requirePermission("staff.manage");
const manageRoles = requirePermission("roles.manage");
// Staff screens need the role list for their role picker; Role Manager needs it too.
adminRouter.get("/roles", requireAnyPermission("staff.manage", "roles.manage"), staffAdmin.roles);
adminRouter.get("/permissions", manageRoles, roleAdmin.permissionCatalogue);
adminRouter.post("/roles", manageRoles, roleAdmin.create);
adminRouter.patch("/roles/:roleKey", manageRoles, roleAdmin.update);
adminRouter.delete("/roles/:roleKey", manageRoles, roleAdmin.remove);
adminRouter.get("/staff", manageStaff, staffAdmin.list);
adminRouter.post("/staff", manageStaff, staffAdmin.create);
adminRouter.get("/staff/:staffId", manageStaff, staffAdmin.getOne);
adminRouter.patch("/staff/:staffId", manageStaff, staffAdmin.update);
adminRouter.post("/staff/:staffId/status", manageStaff, staffAdmin.setStatus);
adminRouter.post("/staff/:staffId/reset-password", manageStaff, staffAdmin.resetPassword);
adminRouter.post("/staff/:staffId/reset-mfa", manageStaff, staffAdmin.resetMfa);
adminRouter.post("/staff/:staffId/revoke-sessions", manageStaff, staffAdmin.revokeSessions);

// Without this an unknown /admin path would fall through to the investor gate
// and answer "a valid investor session is required", which misleads staff.
adminRouter.use(() => { throw HttpError.notFound(); });
