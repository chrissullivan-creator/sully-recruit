import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import Index from "./pages/Index";
import Inbox from "./pages/Inbox";
import Jobs from "./pages/Jobs";
import JobDetail from "./pages/JobDetail";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import SendOut from "./pages/SendOut";
import Companies from "./pages/Companies";
import CompanyDetail from "./pages/CompanyDetail";
import Contacts from "./pages/Contacts";
import ContactDetail from "./pages/ContactDetail";
import People from "./pages/People";
import Sequences from "./pages/Sequences";
import SequenceBuilder from "./pages/SequenceBuilder";
import SequenceScheduleView from "./pages/SequenceScheduleView";
import SequenceAnalyticsPage from "./pages/SequenceAnalyticsPage";
import Calls from "./pages/Calls";
import Tasks from "./pages/Tasks";
import Settings from "./pages/Settings";
import Auth from "./pages/Auth";
import MicrosoftCallback from "./pages/MicrosoftCallback";
import { ResumeSearch } from "./pages/ResumeSearch";
import LinkedInSearch from "./components/LinkedInSearch";
import Source from "./pages/Source";
import SourceProject from "./pages/SourceProject";
import DuplicatesReview from "./pages/DuplicatesReview";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <RouteErrorBoundary>
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
            <Route path="/calls" element={<ProtectedRoute><Calls /></ProtectedRoute>} />
            <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
            <Route path="/resume-search" element={<ProtectedRoute><ResumeSearch /></ProtectedRoute>} />
            <Route path="/linkedin-search" element={<ProtectedRoute><LinkedInSearch /></ProtectedRoute>} />
            <Route path="/duplicates" element={<ProtectedRoute><DuplicatesReview /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </RouteErrorBoundary>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
