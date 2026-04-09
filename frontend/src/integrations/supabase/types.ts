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
      call_logs: {
        Row: {
          audio_url: string | null
          created_at: string
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          external_call_id: string | null
          id: string
          linked_entity_id: string | null
          linked_entity_name: string | null
          linked_entity_type: string | null
          notes: string | null
          owner_id: string | null
          phone_number: string
          started_at: string
          status: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          audio_url?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          external_call_id?: string | null
          id?: string
          linked_entity_id?: string | null
          linked_entity_name?: string | null
          linked_entity_type?: string | null
          notes?: string | null
          owner_id?: string | null
          phone_number: string
          started_at?: string
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          audio_url?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          external_call_id?: string | null
          id?: string
          linked_entity_id?: string | null
          linked_entity_name?: string | null
          linked_entity_type?: string | null
          notes?: string | null
          owner_id?: string | null
          phone_number?: string
          started_at?: string
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      candidate_channels: {
        Row: {
          account_id: string | null
          candidate_id: string
          channel: string
          connected_at: string | null
          created_at: string
          external_conversation_id: string | null
          id: string
          is_connected: boolean
          last_inbound_at: string | null
          last_outbound_at: string | null
          provider_id: string | null
          provider_public_id: string | null
          unipile_id: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          candidate_id: string
          channel: string
          connected_at?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_connected?: boolean
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          provider_id?: string | null
          provider_public_id?: string | null
          unipile_id?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          candidate_id?: string
          channel?: string
          connected_at?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_connected?: boolean
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          provider_id?: string | null
          provider_public_id?: string | null
          unipile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      resumes: {
        Row: {
          ai_summary: string | null
          candidate_id: string | null
          created_at: string | null
          file_name: string | null
          file_path: string
          file_size: number | null
          id: string
          mime_type: string | null
          parse_error: string | null
          parse_status: string | null
          parsed_json: Json | null
          raw_text: string | null
          source: string | null
          storage_bucket: string | null
          updated_at: string | null
        }
        Insert: {
          ai_summary?: string | null
          candidate_id?: string | null
          created_at?: string | null
          file_name?: string | null
          file_path: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          parse_error?: string | null
          parse_status?: string | null
          parsed_json?: Json | null
          raw_text?: string | null
          source?: string | null
          storage_bucket?: string | null
          updated_at?: string | null
        }
        Update: {
          ai_summary?: string | null
          candidate_id?: string | null
          created_at?: string | null
          file_name?: string | null
          file_path?: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          parse_error?: string | null
          parse_status?: string | null
          parsed_json?: Json | null
          raw_text?: string | null
          source?: string | null
          storage_bucket?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      candidates: {
        Row: {
          created_at: string
          company: string | null
          title: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          location: string | null
          owner_id: string | null
          phone: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          company?: string | null
          title?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          location?: string | null
          owner_id?: string | null
          phone?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          company?: string | null
          title?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          location?: string | null
          owner_id?: string | null
          phone?: string | null
          prospect_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidates_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: true
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          company_type: string | null
          created_at: string
          domain: string | null
          domain_normalized: string | null
          id: string
          linkedin_url: string | null
          location: string | null
          name: string
          updated_at: string
        }
        Insert: {
          company_type?: string | null
          created_at?: string
          domain?: string | null
          domain_normalized?: string | null
          id?: string
          linkedin_url?: string | null
          location?: string | null
          name: string
          updated_at?: string
        }
        Update: {
          company_type?: string | null
          created_at?: string
          domain?: string | null
          domain_normalized?: string | null
          id?: string
          linkedin_url?: string | null
          location?: string | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      contact_channels: {
        Row: {
          account_id: string | null
          channel: string
          connected_at: string | null
          contact_id: string
          created_at: string
          external_conversation_id: string | null
          id: string
          is_connected: boolean
          last_inbound_at: string | null
          last_outbound_at: string | null
          provider_id: string | null
          provider_public_id: string | null
          unipile_id: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          channel: string
          connected_at?: string | null
          contact_id: string
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_connected?: boolean
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          provider_id?: string | null
          provider_public_id?: string | null
          unipile_id?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          channel?: string
          connected_at?: string | null
          contact_id?: string
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_connected?: boolean
          last_inbound_at?: string | null
          last_outbound_at?: string | null
          provider_id?: string | null
          provider_public_id?: string | null
          unipile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_channels_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          company_id: string | null
          created_at: string
          department: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          last_name: string | null
          last_reached_out_at: string | null
          last_responded_at: string | null
          linkedin_url: string | null
          owner_id: string | null
          phone: string | null
          status: string
          title: string | null
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          department?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          last_reached_out_at?: string | null
          last_responded_at?: string | null
          linkedin_url?: string | null
          owner_id?: string | null
          phone?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          department?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          last_reached_out_at?: string | null
          last_responded_at?: string | null
          linkedin_url?: string | null
          owner_id?: string | null
          phone?: string | null
          status?: string
          title?: string | null
          updated_at?: string
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
      conversations: {
        Row: {
          account_id: string | null
          candidate_id: string
          channel: string
          contact_id: string | null
          created_at: string
          external_conversation_id: string | null
          id: string
          is_archived: boolean
          is_read: boolean
          last_message_at: string | null
          last_message_preview: string | null
          owner_id: string | null
          send_out_id: string | null
          subject: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          candidate_id: string
          channel: string
          contact_id?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_archived?: boolean
          is_read?: boolean
          last_message_at?: string | null
          last_message_preview?: string | null
          owner_id?: string | null
          send_out_id?: string | null
          subject?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          candidate_id?: string
          channel?: string
          contact_id?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_archived?: boolean
          is_read?: boolean
          last_message_at?: string | null
          last_message_preview?: string | null
          owner_id?: string | null
          send_out_id?: string | null
          subject?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_out_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_accounts: {
        Row: {
          account_label: string | null
          account_type: string
          created_at: string
          external_account_id: string | null
          id: string
          is_active: boolean
          owner_user_id: string | null
          provider: string
          unipile_account_id: string | null
          updated_at: string
        }
        Insert: {
          account_label?: string | null
          account_type: string
          created_at?: string
          external_account_id?: string | null
          id?: string
          is_active?: boolean
          owner_user_id?: string | null
          provider: string
          unipile_account_id?: string | null
          updated_at?: string
        }
        Update: {
          account_label?: string | null
          account_type?: string
          created_at?: string
          external_account_id?: string | null
          id?: string
          is_active?: boolean
          owner_user_id?: string | null
          provider?: string
          unipile_account_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          company_id: string | null
          company_name: string | null
          compensation: string | null
          contact_id: string | null
          created_at: string
          description: string | null
          id: string
          location: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          company_name?: string | null
          compensation?: string | null
          contact_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          location?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          company_name?: string | null
          compensation?: string | null
          contact_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          location?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string | null
          candidate_id: string
          channel: string
          channel_type: string | null
          contact_id: string | null
          conversation_id: string
          created_at: string
          direction: string
          external_message_id: string | null
          id: string
          message_type: string | null
          owner_id: string | null
          provider: string | null
          raw_payload: Json | null
          received_at: string | null
          recipient_address: string | null
          send_out_id: string | null
          sender_address: string | null
          sender_name: string | null
          sent_at: string | null
          subject: string | null
        }
        Insert: {
          body?: string | null
          candidate_id: string
          channel: string
          channel_type?: string | null
          contact_id?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          external_message_id?: string | null
          id?: string
          message_type?: string | null
          owner_id?: string | null
          provider?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          recipient_address?: string | null
          send_out_id?: string | null
          sender_address?: string | null
          sender_name?: string | null
          sent_at?: string | null
          subject?: string | null
        }
        Update: {
          body?: string | null
          candidate_id?: string
          channel?: string
          channel_type?: string | null
          contact_id?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          external_message_id?: string | null
          id?: string
          message_type?: string | null
          owner_id?: string | null
          provider?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          recipient_address?: string | null
          send_out_id?: string | null
          sender_address?: string | null
          sender_name?: string | null
          sent_at?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "inbox_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_out_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          created_at: string
          created_by: string | null
          entity_id: string
          entity_type: string
          id: string
          note: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          entity_id: string
          entity_type: string
          id?: string
          note: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          note?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          is_read: boolean
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          is_read?: boolean
          title: string
          type?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          is_read?: boolean
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      send_outs: {
        Row: {
          candidate_id: string
          contact_id: string | null
          created_at: string
          id: string
          interview_at: string | null
          job_id: string
          offer_at: string | null
          outcome: string | null
          placed_at: string | null
          recruiter_id: string | null
          sent_to_client_at: string | null
          stage: string
          updated_at: string
        }
        Insert: {
          candidate_id: string
          contact_id?: string | null
          created_at?: string
          id?: string
          interview_at?: string | null
          job_id: string
          offer_at?: string | null
          outcome?: string | null
          placed_at?: string | null
          recruiter_id?: string | null
          sent_to_client_at?: string | null
          stage?: string
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          contact_id?: string | null
          created_at?: string
          id?: string
          interview_at?: string | null
          job_id?: string
          offer_at?: string | null
          outcome?: string | null
          placed_at?: string | null
          recruiter_id?: string | null
          sent_to_client_at?: string | null
          stage?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_enrollments: {
        Row: {
          account_id: string | null
          candidate_id: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string
          current_step_order: number | null
          enrolled_at: string
          enrolled_by: string | null
          id: string
          next_step_at: string | null
          paused_at: string | null
          prospect_id: string | null
          send_out_id: string | null
          sequence_id: string
          status: string
          stopped_reason: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          candidate_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          current_step_order?: number | null
          enrolled_at?: string
          enrolled_by?: string | null
          id?: string
          next_step_at?: string | null
          paused_at?: string | null
          prospect_id?: string | null
          send_out_id?: string | null
          sequence_id: string
          status?: string
          stopped_reason?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          candidate_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          current_step_order?: number | null
          enrolled_at?: string
          enrolled_by?: string | null
          id?: string
          next_step_at?: string | null
          paused_at?: string | null
          prospect_id?: string | null
          send_out_id?: string | null
          sequence_id?: string
          status?: string
          stopped_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_enrollments_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_prospect_id_fkey"
            columns: ["prospect_id"]
            isOneToOne: false
            referencedRelation: "prospects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_out_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_step_executions: {
        Row: {
          created_at: string
          enrollment_id: string
          error_message: string | null
          executed_at: string | null
          external_conversation_id: string | null
          external_message_id: string | null
          id: string
          raw_payload: Json | null
          sequence_step_id: string
          status: string
        }
        Insert: {
          created_at?: string
          enrollment_id: string
          error_message?: string | null
          executed_at?: string | null
          external_conversation_id?: string | null
          external_message_id?: string | null
          id?: string
          raw_payload?: Json | null
          sequence_step_id: string
          status?: string
        }
        Update: {
          created_at?: string
          enrollment_id?: string
          error_message?: string | null
          executed_at?: string | null
          external_conversation_id?: string | null
          external_message_id?: string | null
          id?: string
          raw_payload?: Json | null
          sequence_step_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_step_executions_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "sequence_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_step_executions_sequence_step_id_fkey"
            columns: ["sequence_step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_steps: {
        Row: {
          account_id: string | null
          body: string | null
          channel: string | null
          created_at: string
          delay_days: number
          delay_hours: number
          id: string
          is_active: boolean
          is_reply: boolean
          min_hours_after_connection: number
          require_connection: boolean
          send_window_end: number
          send_window_start: number
          sequence_id: string
          step_order: number
          step_type: string
          subject: string | null
          updated_at: string
          use_signature: boolean
          wait_for_connection: boolean
        }
        Insert: {
          account_id?: string | null
          body?: string | null
          channel?: string | null
          created_at?: string
          delay_days?: number
          delay_hours?: number
          id?: string
          is_active?: boolean
          is_reply?: boolean
          min_hours_after_connection?: number
          require_connection?: boolean
          send_window_end?: number
          send_window_start?: number
          sequence_id: string
          step_order: number
          step_type: string
          subject?: string | null
          updated_at?: string
          use_signature?: boolean
          wait_for_connection?: boolean
        }
        Update: {
          account_id?: string | null
          body?: string | null
          channel?: string | null
          created_at?: string
          delay_days?: number
          delay_hours?: number
          id?: string
          is_active?: boolean
          is_reply?: boolean
          min_hours_after_connection?: number
          require_connection?: boolean
          send_window_end?: number
          send_window_start?: number
          sequence_id?: string
          step_order?: number
          step_type?: string
          subject?: string | null
          updated_at?: string
          use_signature?: boolean
          wait_for_connection?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "sequence_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      sequences: {
        Row: {
          channel: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          job_id: string | null
          name: string
          status: string
          stop_on_reply: boolean
          updated_at: string
        }
        Insert: {
          channel?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          job_id?: string | null
          name: string
          status?: string
          stop_on_reply?: boolean
          updated_at?: string
        }
        Update: {
          channel?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          job_id?: string | null
          name?: string
          status?: string
          stop_on_reply?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequences_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      task_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          task_id: string
          user_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          task_id: string
          user_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          task_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_links: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          task_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_links_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          priority: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          priority?: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          priority?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_integrations: {
        Row: {
          config: Json
          created_at: string
          id: string
          integration_type: string
          is_active: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          integration_type: string
          is_active?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          integration_type?: string
          is_active?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          error: string | null
          event_type: string | null
          id: string
          payload: Json
          processed: boolean | null
          processed_at: string | null
          provider: string
          received_at: string | null
        }
        Insert: {
          error?: string | null
          event_type?: string | null
          id?: string
          payload: Json
          processed?: boolean | null
          processed_at?: string | null
          provider: string
          received_at?: string | null
        }
        Update: {
          error?: string | null
          event_type?: string | null
          id?: string
          payload?: Json
          processed?: boolean | null
          processed_at?: string | null
          provider?: string
          received_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      candidate_summary: {
        Row: {
          company: string | null
          title: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string | null
          last_message_at: string | null
          last_name: string | null
          linkedin_url: string | null
          location: string | null
          phone: string | null
          send_out_count: number | null
          status: string | null
        }
        Relationships: []
      }
      inbox_threads: {
        Row: {
          account_id: string | null
          candidate_id: string | null
          candidate_name: string | null
          channel: string | null
          contact_id: string | null
          contact_name: string | null
          id: string | null
          is_archived: boolean | null
          is_read: boolean | null
          last_message_at: string | null
          last_message_preview: string | null
          send_out_id: string | null
          subject: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_out_board"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
        ]
      }
      send_out_board: {
        Row: {
          candidate_id: string | null
          candidate_name: string | null
          company_name: string | null
          contact_id: string | null
          contact_name: string | null
          created_at: string | null
          id: string | null
          interview_at: string | null
          job_id: string | null
          job_title: string | null
          offer_at: string | null
          outcome: string | null
          placed_at: string | null
          sent_to_client_at: string | null
          stage: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      complete_call_with_notes: {
        Args: { p_call_id: string; p_notes: string; p_summary?: string }
        Returns: Json
      }
      match_phone_and_link_call: {
        Args: { p_call_id: string; p_phone_number: string }
        Returns: Json
      }
      promote_prospect_to_candidate: {
        Args: { p_prospect_id: string }
        Returns: {
          created_at: string
          company: string | null
          title: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          location: string | null
          owner_id: string | null
          phone: string | null
          prospect_id: string | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "candidates"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
