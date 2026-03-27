// Lead types
export type LeadStatus = 'new' | 'reached_out' | 'qualified' | 'converted' | 'disqualified' | 'no_answer';
export type LeadType = 'opportunity' | 'lead_candidate' | 'contact' | 'target_company';

export interface Lead {
  id: string;
  type: LeadType;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  status: LeadStatus;
  source?: string;
  createdAt: Date;
  lastContactedAt?: Date;
  tags: string[];
  notes?: string;
}

// Job pipeline stages
export type JobStage = 'lead' | 'hot' | 'offer_made' | 'closed_won' | 'closed_lost';

export interface Job {
  id: string;
  title: string;
  company: string;
  companyId: string;
  location: string;
  salary?: string;
  stage: JobStage;
  priority: 'low' | 'medium' | 'high';
  hiringManager?: string;
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
  candidateCount: number;
}

// Candidate pipeline stages
export type CandidateStage = 
  | 'back_of_resume' 
  | 'pitch' 
  | 'send_out' 
  | 'submitted' 
  | 'interview' 
  | 'first_round' 
  | 'second_round' 
  | 'third_plus_round' 
  | 'offer' 
  | 'accepted' 
  | 'declined' 
  | 'counter_offer'
  | 'disqualified';

export interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  currentTitle: string;
  currentCompany: string;
  linkedinUrl?: string;
  stage: CandidateStage;
  taggedJobId?: string;
  taggedOpportunityId?: string;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
  skills: string[];
}

// Company types
export type CompanyStatus = 'target' | 'client';

export interface Company {
  id: string;
  name: string;
  industry: string;
  website?: string;
  size?: string;
  status: CompanyStatus;
  primaryContact?: string;
  primaryContactId?: string;
  location: string;
  createdAt: Date;
  notes?: string;
  jobCount: number;
}

// Contact types
export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  title: string;
  companyId: string;
  companyName: string;
  isClient: boolean;
  linkedinUrl?: string;
  createdAt: Date;
  lastContactedAt?: Date;
  notes?: string;
}

// Campaign types
export type CampaignType = 'candidate_outreach' | 'account_based' | 'opportunity_based' | 'check_in';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export type ChannelType = 'linkedin_recruiter' | 'sales_nav' | 'linkedin_message' | 'linkedin_connection' | 'email' | 'sms' | 'phone';

export interface CampaignStep {
  id: string;
  order: number;
  channel: ChannelType;
  subject?: string;
  content: string;
  delayDays: number;
  delayHours: number;
  sendWindowStart: number;
  sendWindowEnd: number;
  waitForConnection: boolean;
  minHoursAfterConnection: number;
  isReply: boolean;
  useSignature: boolean;
  accountId?: string;
  condition?: string;
  attachments?: { name: string; path: string; size: number; type: string }[];
}

export interface Campaign {
  id: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  steps: CampaignStep[];
  enrolledCount: number;
  responseRate: number;
  createdAt: Date;
  updatedAt: Date;
}

// Communication types
export type CommunicationType = 'email' | 'linkedin' | 'sms' | 'call' | 'note';

export interface Communication {
  id: string;
  type: CommunicationType;
  direction: 'inbound' | 'outbound';
  subject?: string;
  content: string;
  timestamp: Date;
  recordId: string;
  recordType: 'lead' | 'candidate' | 'contact' | 'company';
  duration?: number; // for calls, in seconds
  audioUrl?: string; // for calls
  summary?: string; // AI-generated summary
}

// Activity types
export interface Activity {
  id: string;
  type: 'email_sent' | 'call_made' | 'meeting_scheduled' | 'note_added' | 'stage_changed' | 'linkedin_sent';
  description: string;
  timestamp: Date;
  userId: string;
  recordId: string;
  recordType: 'lead' | 'candidate' | 'contact' | 'company' | 'job';
}

// Dashboard metrics
export interface DashboardMetrics {
  activeJobs: number;
  activeCandidates: number;
  interviewsThisWeek: number;
  offersOut: number;
  leadsToFollow: number;
  callsToday: number;
  emailsSent: number;
  responseRate: number;
}
