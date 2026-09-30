import { Route, Routes } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ChatProvider } from "./lib/ChatContext";
import { SettingsProvider } from "./lib/SettingsContext";
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
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </OverlayProvider>
      </ChatProvider>
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
