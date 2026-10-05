import { Route, Routes } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ChatProvider } from "./lib/ChatContext";
import { SettingsProvider } from "./lib/SettingsContext";
import { ComplianceProvider } from "./lib/ComplianceContext";
import { ThemeProvider } from "./lib/useTheme";
import { OverlayProvider } from "./components/Modal";
import { AppLayout } from "./components/AppLayout";
import { TooltipProvider, Spinner } from "./components/ui";
import { LogoMark } from "./components/shell/Logo";
import { NotFound } from "./components/shell/NotFound";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Meetings } from "./pages/Meetings";
import { Team } from "./pages/Team";
import { OrgChart } from "./pages/OrgChart";
import { Assistant } from "./pages/Assistant";
import { Attendance } from "./pages/Attendance";
import { AttendanceImport } from "./pages/AttendanceImport";
import { Settings } from "./pages/Settings";
import { ComplianceDashboard } from "./pages/compliance/ComplianceDashboard";
import { Scoreboard } from "./pages/compliance/Scoreboard";
import { MyCompliance } from "./pages/compliance/MyCompliance";
import { ObligationPage } from "./pages/compliance/ObligationPage";
import { Reviews } from "./pages/compliance/Reviews";
import { Notifications } from "./pages/compliance/Notifications";
import { Library } from "./pages/compliance/Library";
import { ComplianceDetail } from "./pages/compliance/ComplianceDetail";
import { ComplianceEditor } from "./pages/compliance/ComplianceEditor";
import { AdminUsers } from "./pages/compliance/AdminUsers";
import { AdminUserDetail } from "./pages/compliance/AdminUserDetail";
import { AdminOrg } from "./pages/compliance/AdminOrg";
import { AdminAccess } from "./pages/compliance/AdminAccess";
import { AdminAudit } from "./pages/compliance/AdminAudit";

function BootSplash() {
  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center gap-4" aria-busy="true">
      <LogoMark size={40} />
      <Spinner size={18} className="text-ink3" />
    </div>
  );
}

function Gate() {
  const { loading, me } = useAuth();

  if (loading && !me) return <BootSplash />;
  if (!me) return <Login />;

  // Settings load after sign-in and set the org time zone before any page renders.
  return (
    <SettingsProvider fallback={<BootSplash />}>
      <ComplianceProvider>
      <ChatProvider>
        <OverlayProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="meetings" element={<Meetings />} />
              <Route path="team" element={<Team />} />
              <Route path="org-chart" element={<OrgChart />} />
              <Route path="assistant" element={<Assistant />} />
              <Route path="attendance" element={<Attendance />} />
              <Route path="attendance/import" element={<AttendanceImport />} />
              <Route path="settings" element={<Settings />} />
              <Route path="compliance" element={<ComplianceDashboard />} />
              <Route path="compliance/mine" element={<MyCompliance />} />
              <Route path="compliance/obligations/:id" element={<ObligationPage />} />
              <Route path="compliance/reviews" element={<Reviews />} />
              <Route path="compliance/notifications" element={<Notifications />} />
              <Route path="compliance/scoreboard" element={<Scoreboard />} />
              <Route path="compliance/library" element={<Library />} />
              <Route path="compliance/library/new" element={<ComplianceEditor />} />
              <Route path="compliance/library/:id" element={<ComplianceDetail />} />
              <Route path="compliance/library/:id/edit" element={<ComplianceEditor />} />
              <Route path="compliance/admin/users" element={<AdminUsers />} />
              <Route path="compliance/admin/users/:email" element={<AdminUserDetail />} />
              <Route path="compliance/admin/org" element={<AdminOrg />} />
              <Route path="compliance/admin/access" element={<AdminAccess />} />
              <Route path="compliance/admin/audit" element={<AdminAudit />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </OverlayProvider>
      </ChatProvider>
      </ComplianceProvider>
    </SettingsProvider>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <TooltipProvider>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
