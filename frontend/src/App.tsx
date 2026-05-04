import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { Loader2 } from "lucide-react";

// Index + Auth load eagerly — they're the landing surfaces.
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";

// Everything else is lazy-loaded so /api hits don't pull in 2.8MB of JS.
const Inbox = lazy(() => import("./pages/Inbox"));
const Jobs = lazy(() => import("./pages/Jobs"));
const JobDetail = lazy(() => import("./pages/JobDetail"));
const Candidates = lazy(() => import("./pages/Candidates"));
const CandidateDetail = lazy(() => import("./pages/CandidateDetail"));
const SendOut = lazy(() => import("./pages/SendOut"));
const SendOuts = lazy(() => import("./pages/SendOuts"));
const AskJoe = lazy(() => import("./pages/AskJoe"));
const Companies = lazy(() => import("./pages/Companies"));
const CompanyDetail = lazy(() => import("./pages/CompanyDetail"));
const Contacts = lazy(() => import("./pages/Contacts"));
const ContactDetail = lazy(() => import("./pages/ContactDetail"));
const People = lazy(() => import("./pages/People"));
const Sequences = lazy(() => import("./pages/Sequences"));
const SequenceBuilder = lazy(() => import("./pages/SequenceBuilder"));
const SequenceScheduleView = lazy(() => import("./pages/SequenceScheduleView"));
const SequenceAnalyticsPage = lazy(() => import("./pages/SequenceAnalyticsPage"));
const Calls = lazy(() => import("./pages/Calls"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Calendar = lazy(() => import("./pages/Calendar"));
const Reports = lazy(() => import("./pages/Reports"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
const Trash = lazy(() => import("./pages/Trash"));
const Status = lazy(() => import("./pages/Status"));
const Settings = lazy(() => import("./pages/Settings"));
const MicrosoftCallback = lazy(() => import("./pages/MicrosoftCallback"));
const ResumeSearch = lazy(() => import("./pages/ResumeSearch").then((m) => ({ default: m.ResumeSearch })));
const LinkedInSearch = lazy(() => import("./components/LinkedInSearch"));
const Source = lazy(() => import("./pages/Source"));
const SourceProject = lazy(() => import("./pages/SourceProject"));
const DuplicatesReview = lazy(() => import("./pages/DuplicatesReview"));

const queryClient = new QueryClient();

function RouteFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-page-bg">
      <Loader2 className="h-6 w-6 animate-spin text-emerald" />
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <RouteErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/microsoft/callback" element={<MicrosoftCallback />} />
            <Route path="/" element={<ProtectedRoute><Index /></ProtectedRoute>} />
            <Route path="/inbox" element={<ProtectedRoute><Inbox /></ProtectedRoute>} />
            <Route path="/jobs" element={<ProtectedRoute><Jobs /></ProtectedRoute>} />
            <Route path="/jobs/:id" element={<ProtectedRoute><JobDetail /></ProtectedRoute>} />
            <Route path="/candidates" element={<ProtectedRoute><Candidates /></ProtectedRoute>} />
            <Route path="/candidates/:id" element={<ProtectedRoute><CandidateDetail /></ProtectedRoute>} />
            <Route path="/candidates/:id/sendout" element={<ProtectedRoute><SendOut /></ProtectedRoute>} />
            <Route path="/companies" element={<ProtectedRoute><Companies /></ProtectedRoute>} />
            <Route path="/companies/:id" element={<ProtectedRoute><CompanyDetail /></ProtectedRoute>} />
            <Route path="/contacts" element={<ProtectedRoute><Contacts /></ProtectedRoute>} />
            <Route path="/contacts/:id" element={<ProtectedRoute><ContactDetail /></ProtectedRoute>} />
            <Route path="/people" element={<ProtectedRoute><People /></ProtectedRoute>} />
            <Route path="/sequences" element={<ProtectedRoute><Sequences /></ProtectedRoute>} />
            <Route path="/sequences/new" element={<ProtectedRoute><SequenceBuilder /></ProtectedRoute>} />
            <Route path="/sequences/:id/edit" element={<ProtectedRoute><SequenceBuilder /></ProtectedRoute>} />
            <Route path="/sequences/:id/schedule" element={<ProtectedRoute><SequenceScheduleView /></ProtectedRoute>} />
            <Route path="/sequences/:id/analytics" element={<ProtectedRoute><SequenceAnalyticsPage /></ProtectedRoute>} />
            <Route path="/campaigns" element={<ProtectedRoute><Sequences /></ProtectedRoute>} />
            <Route path="/source" element={<ProtectedRoute><Source /></ProtectedRoute>} />
            <Route path="/source/:id" element={<ProtectedRoute><SourceProject /></ProtectedRoute>} />
            <Route path="/send-outs" element={<ProtectedRoute><SendOuts /></ProtectedRoute>} />
            <Route path="/ask-joe" element={<ProtectedRoute><AskJoe /></ProtectedRoute>} />
            <Route path="/calls" element={<ProtectedRoute><Calls /></ProtectedRoute>} />
            <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
            <Route path="/calendar" element={<ProtectedRoute><Calendar /></ProtectedRoute>} />
            <Route path="/reports" element={<ProtectedRoute><Reports /></ProtectedRoute>} />
            <Route path="/audit" element={<ProtectedRoute><AuditLog /></ProtectedRoute>} />
            <Route path="/audit/trash" element={<ProtectedRoute><Trash /></ProtectedRoute>} />
            {/* /status is intentionally NOT wrapped in ProtectedRoute — recruiters
                who can't sign in can still tell whether the system or their session
                is the problem. */}
            <Route path="/status" element={<Status />} />
            <Route path="/resume-search" element={<ProtectedRoute><ResumeSearch /></ProtectedRoute>} />
            <Route path="/linkedin-search" element={<ProtectedRoute><LinkedInSearch /></ProtectedRoute>} />
            <Route path="/duplicates" element={<ProtectedRoute><DuplicatesReview /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </RouteErrorBoundary>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
