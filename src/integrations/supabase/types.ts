export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      activities: {
        Row: {
          description: string
          id: string
          record_id: string
          record_type: Database["public"]["Enums"]["record_type"]
          timestamp: string
          type: Database["public"]["Enums"]["activity_type"]
          user_id: string
        }
        Insert: {
          description?: string
          id?: string
          record_id: string
          record_type: Database["public"]["Enums"]["record_type"]
          timestamp?: string
          type: Database["public"]["Enums"]["activity_type"]
          user_id: string
        }
        Update: {
          description?: string
          id?: string
          record_id?: string
          record_type?: Database["public"]["Enums"]["record_type"]
          timestamp?: string
          type?: Database["public"]["Enums"]["activity_type"]
          user_id?: string
        }
        Relationships: []
      }
      campaign_steps: {
        Row: {
          campaign_id: string
          channel: Database["public"]["Enums"]["channel_type"]
          condition: string | null
          content: string
          created_at: string
          delay_days: number
          id: string
          order: number
          subject: string | null
        }
        Insert: {
          campaign_id: string
          channel?: Database["public"]["Enums"]["channel_type"]
          condition?: string | null
          content?: string
          created_at?: string
          delay_days?: number
          id?: string
          order?: number
          subject?: string | null
        }
        Update: {
          campaign_id?: string
          channel?: Database["public"]["Enums"]["channel_type"]
          condition?: string | null
          content?: string
          created_at?: string
          delay_days?: number
          id?: string
          order?: number
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_steps_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          created_at: string
          enrolled_count: number
          id: string
          name: string
          response_rate: number
          status: Database["public"]["Enums"]["campaign_status"]
          type: Database["public"]["Enums"]["campaign_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enrolled_count?: number
          id?: string
          name: string
          response_rate?: number
          status?: Database["public"]["Enums"]["campaign_status"]
          type?: Database["public"]["Enums"]["campaign_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          enrolled_count?: number
          id?: string
          name?: string
          response_rate?: number
          status?: Database["public"]["Enums"]["campaign_status"]
          type?: Database["public"]["Enums"]["campaign_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      candidates: {
        Row: {
          created_at: string
          current_company: string
          current_title: string
          email: string
          first_name: string
          id: string
          last_name: string
          linkedin_url: string | null
          notes: string | null
          phone: string | null
          skills: string[]
          source: string | null
          stage: Database["public"]["Enums"]["candidate_stage"]
          tagged_job_id: string | null
          tagged_opportunity_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_company?: string
          current_title?: string
          email?: string
          first_name: string
          id?: string
          last_name: string
          linkedin_url?: string | null
          notes?: string | null
          phone?: string | null
          skills?: string[]
          source?: string | null
          stage?: Database["public"]["Enums"]["candidate_stage"]
          tagged_job_id?: string | null
          tagged_opportunity_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_company?: string
          current_title?: string
          email?: string
          first_name?: string
          id?: string
          last_name?: string
          linkedin_url?: string | null
          notes?: string | null
          phone?: string | null
          skills?: string[]
          source?: string | null
          stage?: Database["public"]["Enums"]["candidate_stage"]
          tagged_job_id?: string | null
          tagged_opportunity_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidates_tagged_job_id_fkey"
            columns: ["tagged_job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      communications: {
        Row: {
          audio_url: string | null
          content: string
          direction: Database["public"]["Enums"]["communication_direction"]
          duration: number | null
          id: string
          record_id: string
          record_type: Database["public"]["Enums"]["record_type"]
          subject: string | null
          summary: string | null
          timestamp: string
          type: Database["public"]["Enums"]["communication_type"]
          user_id: string
        }
        Insert: {
          audio_url?: string | null
          content?: string
          direction?: Database["public"]["Enums"]["communication_direction"]
          duration?: number | null
          id?: string
          record_id: string
          record_type: Database["public"]["Enums"]["record_type"]
          subject?: string | null
          summary?: string | null
          timestamp?: string
          type?: Database["public"]["Enums"]["communication_type"]
          user_id: string
        }
        Update: {
          audio_url?: string | null
          content?: string
          direction?: Database["public"]["Enums"]["communication_direction"]
          duration?: number | null
          id?: string
          record_id?: string
          record_type?: Database["public"]["Enums"]["record_type"]
          subject?: string | null
          summary?: string | null
          timestamp?: string
          type?: Database["public"]["Enums"]["communication_type"]
          user_id?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          created_at: string
          id: string
          industry: string
          job_count: number
          location: string
          name: string
          notes: string | null
          primary_contact: string | null
          primary_contact_id: string | null
          size: string | null
          status: Database["public"]["Enums"]["company_status"]
          updated_at: string
          user_id: string
          website: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          industry?: string
          job_count?: number
          location?: string
          name: string
          notes?: string | null
          primary_contact?: string | null
          primary_contact_id?: string | null
          size?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          updated_at?: string
          user_id: string
          website?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          industry?: string
          job_count?: number
          location?: string
          name?: string
          notes?: string | null
          primary_contact?: string | null
          primary_contact_id?: string | null
          size?: string | null
          status?: Database["public"]["Enums"]["company_status"]
          updated_at?: string
          user_id?: string
          website?: string | null
        }
        Relationships: []
      }
      contacts: {
        Row: {
          company_id: string | null
          company_name: string
          created_at: string
          email: string
          first_name: string
          id: string
          is_client: boolean
          last_contacted_at: string | null
          last_name: string
          linkedin_url: string | null
          notes: string | null
          phone: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id?: string | null
          company_name?: string
          created_at?: string
          email?: string
          first_name: string
          id?: string
          is_client?: boolean
          last_contacted_at?: string | null
          last_name: string
          linkedin_url?: string | null
          notes?: string | null
          phone?: string | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string | null
          company_name?: string
          created_at?: string
          email?: string
          first_name?: string
          id?: string
          is_client?: boolean
          last_contacted_at?: string | null
          last_name?: string
          linkedin_url?: string | null
          notes?: string | null
          phone?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          candidate_count: number
          company: string
          company_id: string | null
          created_at: string
          hiring_manager: string | null
          id: string
          location: string
          notes: string | null
          priority: Database["public"]["Enums"]["priority_level"]
          salary: string | null
          stage: Database["public"]["Enums"]["job_stage"]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          candidate_count?: number
          company?: string
          company_id?: string | null
          created_at?: string
          hiring_manager?: string | null
          id?: string
          location?: string
          notes?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          salary?: string | null
          stage?: Database["public"]["Enums"]["job_stage"]
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          candidate_count?: number
          company?: string
          company_id?: string | null
          created_at?: string
          hiring_manager?: string | null
          id?: string
          location?: string
          notes?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          salary?: string | null
          stage?: Database["public"]["Enums"]["job_stage"]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          id: string
          last_contacted_at: string | null
          name: string
          notes: string | null
          phone: string | null
          source: string | null
          status: Database["public"]["Enums"]["lead_status"]
          tags: string[]
          title: string | null
          type: Database["public"]["Enums"]["lead_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          last_contacted_at?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          tags?: string[]
          title?: string | null
          type?: Database["public"]["Enums"]["lead_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          last_contacted_at?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          tags?: string[]
          title?: string | null
          type?: Database["public"]["Enums"]["lead_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      activity_type:
        | "email_sent"
        | "call_made"
        | "meeting_scheduled"
        | "note_added"
        | "stage_changed"
        | "linkedin_sent"
      campaign_status: "draft" | "active" | "paused" | "completed"
      campaign_type:
        | "candidate_outreach"
        | "account_based"
        | "opportunity_based"
        | "check_in"
      candidate_stage:
        | "back_of_resume"
        | "pitch"
        | "send_out"
        | "submitted"
        | "interview"
        | "first_round"
        | "second_round"
        | "third_plus_round"
        | "offer"
        | "accepted"
        | "declined"
        | "counter_offer"
        | "disqualified"
      channel_type:
        | "linkedin_recruiter"
        | "sales_nav"
        | "linkedin_message"
        | "linkedin_connection"
        | "email"
        | "sms"
        | "phone"
      communication_direction: "inbound" | "outbound"
      communication_type: "email" | "linkedin" | "sms" | "call" | "note"
      company_status: "target" | "client"
      job_stage:
        | "warm"
        | "hot"
        | "interviewing"
        | "offer"
        | "accepted"
        | "declined"
        | "lost"
        | "on_hold"
      lead_status:
        | "new"
        | "reached_out"
        | "qualified"
        | "converted"
        | "disqualified"
        | "no_answer"
      lead_type: "opportunity" | "lead_candidate" | "contact" | "target_company"
      priority_level: "low" | "medium" | "high"
      record_type: "lead" | "candidate" | "contact" | "company" | "job"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      activity_type: [
        "email_sent",
        "call_made",
        "meeting_scheduled",
        "note_added",
        "stage_changed",
        "linkedin_sent",
      ],
      campaign_status: ["draft", "active", "paused", "completed"],
      campaign_type: [
        "candidate_outreach",
        "account_based",
        "opportunity_based",
        "check_in",
      ],
      candidate_stage: [
        "back_of_resume",
        "pitch",
        "send_out",
        "submitted",
        "interview",
        "first_round",
        "second_round",
        "third_plus_round",
        "offer",
        "accepted",
        "declined",
        "counter_offer",
        "disqualified",
      ],
      channel_type: [
        "linkedin_recruiter",
        "sales_nav",
        "linkedin_message",
        "linkedin_connection",
        "email",
        "sms",
        "phone",
      ],
      communication_direction: ["inbound", "outbound"],
      communication_type: ["email", "linkedin", "sms", "call", "note"],
      company_status: ["target", "client"],
      job_stage: [
        "warm",
        "hot",
        "interviewing",
        "offer",
        "accepted",
        "declined",
        "lost",
        "on_hold",
      ],
      lead_status: [
        "new",
        "reached_out",
        "qualified",
        "converted",
        "disqualified",
        "no_answer",
      ],
      lead_type: ["opportunity", "lead_candidate", "contact", "target_company"],
      priority_level: ["low", "medium", "high"],
      record_type: ["lead", "candidate", "contact", "company", "job"],
    },
  },
} as const
