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
      ai_call_notes: {
        Row: {
          ai_action_items: string | null
          ai_summary: string | null
          call_direction: string | null
          call_duration_formatted: string | null
          call_duration_seconds: number | null
          call_ended_at: string | null
          call_log_id: string | null
          call_started_at: string | null
          candidate_id: string | null
          contact_id: string | null
          created_at: string | null
          embedding: string | null
          external_call_id: string | null
          extracted_current_base: number | null
          extracted_current_bonus: number | null
          extracted_notes: string | null
          extracted_reason_for_leaving: string | null
          extracted_target_base: number | null
          extracted_target_bonus: number | null
          id: string
          owner_id: string | null
          phone_number: string | null
          processing_status: string | null
          recording_url: string | null
          source: string | null
          structured_notes: Json | null
          transcript: string | null
          transcription_provider: string | null
          updated_candidates_at: string | null
        }
        Insert: {
          ai_action_items?: string | null
          ai_summary?: string | null
          call_direction?: string | null
          call_duration_formatted?: string | null
          call_duration_seconds?: number | null
          call_ended_at?: string | null
          call_log_id?: string | null
          call_started_at?: string | null
          candidate_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          embedding?: string | null
          external_call_id?: string | null
          extracted_current_base?: number | null
          extracted_current_bonus?: number | null
          extracted_notes?: string | null
          extracted_reason_for_leaving?: string | null
          extracted_target_base?: number | null
          extracted_target_bonus?: number | null
          id?: string
          owner_id?: string | null
          phone_number?: string | null
          processing_status?: string | null
          recording_url?: string | null
          source?: string | null
          structured_notes?: Json | null
          transcript?: string | null
          transcription_provider?: string | null
          updated_candidates_at?: string | null
        }
        Update: {
          ai_action_items?: string | null
          ai_summary?: string | null
          call_direction?: string | null
          call_duration_formatted?: string | null
          call_duration_seconds?: number | null
          call_ended_at?: string | null
          call_log_id?: string | null
          call_started_at?: string | null
          candidate_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          embedding?: string | null
          external_call_id?: string | null
          extracted_current_base?: number | null
          extracted_current_bonus?: number | null
          extracted_notes?: string | null
          extracted_reason_for_leaving?: string | null
          extracted_target_base?: number | null
          extracted_target_bonus?: number | null
          id?: string
          owner_id?: string | null
          phone_number?: string | null
          processing_status?: string | null
          recording_url?: string | null
          source?: string | null
          structured_notes?: Json | null
          transcript?: string | null
          transcription_provider?: string | null
          updated_candidates_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_call_notes_call_log_id_fkey"
            columns: ["call_log_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_call_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_runs: {
        Row: {
          candidate_id: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string
          estimated_cost_usd: number | null
          id: string
          input_text: string | null
          input_tokens: number | null
          job_id: string | null
          model: string | null
          output_tokens: number | null
          person_id: string | null
          prompt_version: string | null
          provider: string | null
          request_payload: Json
          response_metadata: Json
          response_text: string | null
          send_out_id: string | null
          started_at: string
          status: string
          task_id: string | null
          total_tokens: number | null
          trigger_run_id: string | null
          updated_at: string
          user_id: string | null
          workflow_kind: string
        }
        Insert: {
          candidate_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          input_text?: string | null
          input_tokens?: number | null
          job_id?: string | null
          model?: string | null
          output_tokens?: number | null
          person_id?: string | null
          prompt_version?: string | null
          provider?: string | null
          request_payload?: Json
          response_metadata?: Json
          response_text?: string | null
          send_out_id?: string | null
          started_at?: string
          status?: string
          task_id?: string | null
          total_tokens?: number | null
          trigger_run_id?: string | null
          updated_at?: string
          user_id?: string | null
          workflow_kind: string
        }
        Update: {
          candidate_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          input_text?: string | null
          input_tokens?: number | null
          job_id?: string | null
          model?: string | null
          output_tokens?: number | null
          person_id?: string | null
          prompt_version?: string | null
          provider?: string | null
          request_payload?: Json
          response_metadata?: Json
          response_text?: string | null
          send_out_id?: string | null
          started_at?: string
          status?: string
          task_id?: string | null
          total_tokens?: number | null
          trigger_run_id?: string | null
          updated_at?: string
          user_id?: string | null
          workflow_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_runs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_runs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string | null
          description: string | null
          key: string
          updated_at: string | null
          value: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          key: string
          updated_at?: string | null
          value: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          key?: string
          updated_at?: string | null
          value?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          after: Json | null
          at: string
          before: Json | null
          changed: Json | null
          id: number
          row_id: string
          table_name: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          after?: Json | null
          at?: string
          before?: Json | null
          changed?: Json | null
          id?: number
          row_id: string
          table_name: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          after?: Json | null
          at?: string
          before?: Json | null
          changed?: Json | null
          id?: number
          row_id?: string
          table_name?: string
        }
        Relationships: []
      }
      call_logs: {
        Row: {
          audio_url: string | null
          candidate_id: string | null
          contact_id: string | null
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
          candidate_id?: string | null
          contact_id?: string | null
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
          candidate_id?: string | null
          contact_id?: string | null
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
        Relationships: [
          {
            foreignKeyName: "call_logs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      call_processing_queue: {
        Row: {
          attempts: number
          call_direction: string | null
          call_ended_at: string | null
          call_id: string
          call_started_at: string | null
          candidate_id: string | null
          contact_id: string | null
          created_at: string
          duration_seconds: number | null
          error: string | null
          id: string
          owner_id: string | null
          phone_number: string | null
          session_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          call_direction?: string | null
          call_ended_at?: string | null
          call_id: string
          call_started_at?: string | null
          candidate_id?: string | null
          contact_id?: string | null
          created_at?: string
          duration_seconds?: number | null
          error?: string | null
          id?: string
          owner_id?: string | null
          phone_number?: string | null
          session_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          call_direction?: string | null
          call_ended_at?: string | null
          call_id?: string
          call_started_at?: string | null
          candidate_id?: string | null
          contact_id?: string | null
          created_at?: string
          duration_seconds?: number | null
          error?: string | null
          id?: string
          owner_id?: string | null
          phone_number?: string | null
          session_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_processing_queue_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_processing_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_channels: {
        Row: {
          account_id: string | null
          candidate_id: string
          channel: string
          connection_status: string | null
          created_at: string
          external_conversation_id: string | null
          id: string
          is_connected: boolean
          last_synced_at: string | null
          provider_id: string | null
          unipile_id: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          candidate_id: string
          channel: string
          connection_status?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_connected?: boolean
          last_synced_at?: string | null
          provider_id?: string | null
          unipile_id?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          candidate_id?: string
          channel?: string
          connection_status?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          is_connected?: boolean
          last_synced_at?: string | null
          provider_id?: string | null
          unipile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_channels_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "integration_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_documents: {
        Row: {
          candidate_id: string
          category: string
          created_at: string
          created_by: string | null
          file_name: string
          file_path: string
          file_size: number | null
          id: string
          mime_type: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          category?: string
          created_at?: string
          created_by?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          category?: string
          created_at?: string
          created_by?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_education: {
        Row: {
          candidate_id: string
          created_at: string
          degree: string | null
          end_year: number | null
          field_of_study: string | null
          id: string
          institution: string
          start_year: number | null
        }
        Insert: {
          candidate_id: string
          created_at?: string
          degree?: string | null
          end_year?: number | null
          field_of_study?: string | null
          id?: string
          institution: string
          start_year?: number | null
        }
        Update: {
          candidate_id?: string
          created_at?: string
          degree?: string | null
          end_year?: number | null
          field_of_study?: string | null
          id?: string
          institution?: string
          start_year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_education_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_education_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_education_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_education_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_education_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_jobs: {
        Row: {
          candidate_id: string
          closed_at: string | null
          created_at: string
          disqualified_by: string | null
          disqualified_reason: string | null
          id: string
          interview_round: number | null
          interviewing_at: string | null
          job_id: string
          pipeline_stage: string
          pitched_at: string | null
          reached_out_at: string | null
          reactivated_at: string | null
          ready_to_send_at: string | null
          rejected_at: string | null
          rejected_by: string | null
          rejected_from_stage: string | null
          rejection_notes: string | null
          rejection_reason: string | null
          sent_at: string | null
          stage_updated_at: string | null
          updated_at: string
          withdrawn_reason: string | null
        }
        Insert: {
          candidate_id: string
          closed_at?: string | null
          created_at?: string
          disqualified_by?: string | null
          disqualified_reason?: string | null
          id?: string
          interview_round?: number | null
          interviewing_at?: string | null
          job_id: string
          pipeline_stage?: string
          pitched_at?: string | null
          reached_out_at?: string | null
          reactivated_at?: string | null
          ready_to_send_at?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_from_stage?: string | null
          rejection_notes?: string | null
          rejection_reason?: string | null
          sent_at?: string | null
          stage_updated_at?: string | null
          updated_at?: string
          withdrawn_reason?: string | null
        }
        Update: {
          candidate_id?: string
          closed_at?: string | null
          created_at?: string
          disqualified_by?: string | null
          disqualified_reason?: string | null
          id?: string
          interview_round?: number | null
          interviewing_at?: string | null
          job_id?: string
          pipeline_stage?: string
          pitched_at?: string | null
          reached_out_at?: string | null
          reactivated_at?: string | null
          ready_to_send_at?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejected_from_stage?: string | null
          rejection_notes?: string | null
          rejection_reason?: string | null
          sent_at?: string | null
          stage_updated_at?: string | null
          updated_at?: string
          withdrawn_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_jobs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_jobs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_jobs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_jobs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_jobs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_jobs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_merge_log: {
        Row: {
          created_at: string | null
          id: string
          merged_by: string | null
          merged_data: Json
          merged_id: string
          survivor_id: string
          tables_updated: Json | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          merged_by?: string | null
          merged_data: Json
          merged_id: string
          survivor_id: string
          tables_updated?: Json | null
        }
        Update: {
          created_at?: string | null
          id?: string
          merged_by?: string | null
          merged_data?: Json
          merged_id?: string
          survivor_id?: string
          tables_updated?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_merge_log_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_merge_log_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_merge_log_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_merge_log_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_merge_log_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_work_history: {
        Row: {
          candidate_id: string
          company_name: string
          created_at: string
          description: string | null
          end_date: string | null
          id: string
          is_current: boolean
          start_date: string | null
          title: string | null
        }
        Insert: {
          candidate_id: string
          company_name: string
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          is_current?: boolean
          start_date?: string | null
          title?: string | null
        }
        Update: {
          candidate_id?: string
          company_name?: string
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          is_current?: boolean
          start_date?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_work_history_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_work_history_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_work_history_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_work_history_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_work_history_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_limits: {
        Row: {
          channel: string
          daily_max: number | null
          hourly_max: number | null
          respect_send_window: boolean
        }
        Insert: {
          channel: string
          daily_max?: number | null
          hourly_max?: number | null
          respect_send_window?: boolean
        }
        Update: {
          channel?: string
          daily_max?: number | null
          hourly_max?: number | null
          respect_send_window?: boolean
        }
        Relationships: []
      }
      companies: {
        Row: {
          company_type: string | null
          created_at: string
          deleted_at: string | null
          deleted_by_user_id: string | null
          description: string | null
          domain: string | null
          domain_normalized: string | null
          hq_location: string | null
          id: string
          industry: string | null
          linkedin_url: string | null
          location: string | null
          logo_url: string | null
          name: string
          size: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          company_type?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          description?: string | null
          domain?: string | null
          domain_normalized?: string | null
          hq_location?: string | null
          id?: string
          industry?: string | null
          linkedin_url?: string | null
          location?: string | null
          logo_url?: string | null
          name: string
          size?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          company_type?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          description?: string | null
          domain?: string | null
          domain_normalized?: string | null
          hq_location?: string | null
          id?: string
          industry?: string | null
          linkedin_url?: string | null
          location?: string | null
          logo_url?: string | null
          name?: string
          size?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      company_contracts: {
        Row: {
          base_salary: number | null
          company_id: string
          contract_type: string | null
          created_at: string
          created_by: string | null
          effective_date: string | null
          expiration_date: string | null
          fee_pct: number | null
          fee_type: string | null
          file_name: string
          file_path: string
          file_size: number | null
          id: string
          mime_type: string | null
          notes: string | null
          other_notes: string | null
          payment_terms: string | null
          status: string | null
          total_comp: number | null
          updated_at: string
        }
        Insert: {
          base_salary?: number | null
          company_id: string
          contract_type?: string | null
          created_at?: string
          created_by?: string | null
          effective_date?: string | null
          expiration_date?: string | null
          fee_pct?: number | null
          fee_type?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          other_notes?: string | null
          payment_terms?: string | null
          status?: string | null
          total_comp?: number | null
          updated_at?: string
        }
        Update: {
          base_salary?: number | null
          company_id?: string
          contract_type?: string | null
          created_at?: string
          created_by?: string | null
          effective_date?: string | null
          expiration_date?: string | null
          fee_pct?: number | null
          fee_type?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          other_notes?: string | null
          payment_terms?: string | null
          status?: string | null
          total_comp?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_contracts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_contracts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
        ]
      }
      company_domains: {
        Row: {
          company_id: string
          created_at: string
          domain: string
          id: string
          is_primary: boolean
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          domain: string
          id?: string
          is_primary?: boolean
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          domain?: string
          id?: string
          is_primary?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_domains_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_domains_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
        ]
      }
      contact_embeddings: {
        Row: {
          contact_id: string
          created_at: string
          embed_model: string
          embed_type: string
          embedding: string | null
          id: string
          source_text: string | null
          updated_at: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          embed_model?: string
          embed_type?: string
          embedding?: string | null
          id?: string
          source_text?: string | null
          updated_at?: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          embed_model?: string
          embed_type?: string
          embedding?: string | null
          id?: string
          source_text?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_embeddings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_embeddings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_embeddings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_embeddings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_embeddings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          account_id: string | null
          assigned_user_id: string | null
          candidate_id: string | null
          channel: string
          contact_id: string | null
          content_type: string | null
          created_at: string
          external_conversation_id: string | null
          id: string
          integration_account_id: string | null
          is_archived: boolean
          is_read: boolean
          last_message_at: string | null
          last_message_preview: string | null
          owner_id: string | null
          role_context: string | null
          send_out_id: string | null
          subject: string | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          assigned_user_id?: string | null
          candidate_id?: string | null
          channel: string
          contact_id?: string | null
          content_type?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          integration_account_id?: string | null
          is_archived?: boolean
          is_read?: boolean
          last_message_at?: string | null
          last_message_preview?: string | null
          owner_id?: string | null
          role_context?: string | null
          send_out_id?: string | null
          subject?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          assigned_user_id?: string | null
          candidate_id?: string | null
          channel?: string
          contact_id?: string | null
          content_type?: string | null
          created_at?: string
          external_conversation_id?: string | null
          id?: string
          integration_account_id?: string | null
          is_archived?: boolean
          is_read?: boolean
          last_message_at?: string | null
          last_message_preview?: string | null
          owner_id?: string | null
          role_context?: string | null
          send_out_id?: string | null
          subject?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
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
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_integration_account_id_fkey"
            columns: ["integration_account_id"]
            isOneToOne: false
            referencedRelation: "integration_accounts"
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
      daily_send_log: {
        Row: {
          account_id: string
          channel: string
          count: number
          id: string
          send_date: string
        }
        Insert: {
          account_id: string
          channel: string
          count?: number
          id?: string
          send_date: string
        }
        Update: {
          account_id?: string
          channel?: string
          count?: number
          id?: string
          send_date?: string
        }
        Relationships: []
      }
      deleted_candidate_blacklist: {
        Row: {
          created_at: string
          deleted_by: string | null
          email: string | null
          file_name: string | null
          full_name: string | null
          id: string
          linkedin_url: string | null
          reason: string | null
        }
        Insert: {
          created_at?: string
          deleted_by?: string | null
          email?: string | null
          file_name?: string | null
          full_name?: string | null
          id?: string
          linkedin_url?: string | null
          reason?: string | null
        }
        Update: {
          created_at?: string
          deleted_by?: string | null
          email?: string | null
          file_name?: string | null
          full_name?: string | null
          id?: string
          linkedin_url?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      duplicate_candidates: {
        Row: {
          candidate_id_a: string
          candidate_id_b: string
          confidence: number | null
          created_at: string | null
          id: string
          match_type: string
          match_value: string | null
          merged_at: string | null
          merged_by: string | null
          status: string
          survivor_id: string | null
        }
        Insert: {
          candidate_id_a: string
          candidate_id_b: string
          confidence?: number | null
          created_at?: string | null
          id?: string
          match_type: string
          match_value?: string | null
          merged_at?: string | null
          merged_by?: string | null
          status?: string
          survivor_id?: string | null
        }
        Update: {
          candidate_id_a?: string
          candidate_id_b?: string
          confidence?: number | null
          created_at?: string | null
          id?: string
          match_type?: string
          match_value?: string | null
          merged_at?: string | null
          merged_by?: string | null
          status?: string
          survivor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "duplicate_candidates_candidate_id_a_fkey"
            columns: ["candidate_id_a"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_a_fkey"
            columns: ["candidate_id_a"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_a_fkey"
            columns: ["candidate_id_a"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_a_fkey"
            columns: ["candidate_id_a"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_a_fkey"
            columns: ["candidate_id_a"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_b_fkey"
            columns: ["candidate_id_b"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_b_fkey"
            columns: ["candidate_id_b"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_b_fkey"
            columns: ["candidate_id_b"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_b_fkey"
            columns: ["candidate_id_b"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_candidate_id_b_fkey"
            columns: ["candidate_id_b"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_survivor_id_fkey"
            columns: ["survivor_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      formatted_resumes: {
        Row: {
          candidate_id: string
          created_at: string
          created_by: string | null
          file_name: string | null
          file_path: string | null
          file_size: number | null
          id: string
          job_id: string | null
          mime_type: string | null
          notes: string | null
          resume_id: string | null
          updated_at: string
          version_label: string
        }
        Insert: {
          candidate_id: string
          created_at?: string
          created_by?: string | null
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          id?: string
          job_id?: string | null
          mime_type?: string | null
          notes?: string | null
          resume_id?: string | null
          updated_at?: string
          version_label?: string
        }
        Update: {
          candidate_id?: string
          created_at?: string
          created_by?: string | null
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          id?: string
          job_id?: string | null
          mime_type?: string | null
          notes?: string | null
          resume_id?: string | null
          updated_at?: string
          version_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "formatted_resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formatted_resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formatted_resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formatted_resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formatted_resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formatted_resumes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formatted_resumes_resume_id_fkey"
            columns: ["resume_id"]
            isOneToOne: false
            referencedRelation: "resumes"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_subscriptions: {
        Row: {
          created_at: string
          email_address: string
          expires_at: string
          id: string
          subscription_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_address: string
          expires_at: string
          id?: string
          subscription_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_address?: string
          expires_at?: string
          id?: string
          subscription_id?: string
          user_id?: string
        }
        Relationships: []
      }
      integration_accounts: {
        Row: {
          access_token: string | null
          account_label: string | null
          account_type: string
          auth_provider: string
          created_at: string
          daily_send_limit: number
          email_address: string | null
          external_account_id: string | null
          hourly_send_limit: number
          id: string
          is_active: boolean
          linkedin_capabilities: Json | null
          linkedin_capability: string | null
          linkedin_daily_connection_limit: number | null
          linkedin_daily_message_limit: number | null
          linkedin_next_available_connection_at: string | null
          linkedin_next_available_send_at: string | null
          mailbox_identifier: string | null
          mailbox_user_id: string | null
          metadata: Json | null
          microsoft_subscription_expires_at: string | null
          microsoft_subscription_id: string | null
          microsoft_user_id: string | null
          next_available_send_at: string | null
          owner_user_id: string | null
          provider: string
          rc_extension: string | null
          rc_jwt: string | null
          rc_phone_number: string | null
          refresh_token: string | null
          sending_window_end: string
          sending_window_start: string
          timezone: string
          token_expires_at: string | null
          unipile_account_id: string | null
          unipile_provider: string | null
          updated_at: string
          user_id: string | null
          webhook_subscription_id: string | null
        }
        Insert: {
          access_token?: string | null
          account_label?: string | null
          account_type: string
          auth_provider: string
          created_at?: string
          daily_send_limit?: number
          email_address?: string | null
          external_account_id?: string | null
          hourly_send_limit?: number
          id?: string
          is_active?: boolean
          linkedin_capabilities?: Json | null
          linkedin_capability?: string | null
          linkedin_daily_connection_limit?: number | null
          linkedin_daily_message_limit?: number | null
          linkedin_next_available_connection_at?: string | null
          linkedin_next_available_send_at?: string | null
          mailbox_identifier?: string | null
          mailbox_user_id?: string | null
          metadata?: Json | null
          microsoft_subscription_expires_at?: string | null
          microsoft_subscription_id?: string | null
          microsoft_user_id?: string | null
          next_available_send_at?: string | null
          owner_user_id?: string | null
          provider: string
          rc_extension?: string | null
          rc_jwt?: string | null
          rc_phone_number?: string | null
          refresh_token?: string | null
          sending_window_end?: string
          sending_window_start?: string
          timezone?: string
          token_expires_at?: string | null
          unipile_account_id?: string | null
          unipile_provider?: string | null
          updated_at?: string
          user_id?: string | null
          webhook_subscription_id?: string | null
        }
        Update: {
          access_token?: string | null
          account_label?: string | null
          account_type?: string
          auth_provider?: string
          created_at?: string
          daily_send_limit?: number
          email_address?: string | null
          external_account_id?: string | null
          hourly_send_limit?: number
          id?: string
          is_active?: boolean
          linkedin_capabilities?: Json | null
          linkedin_capability?: string | null
          linkedin_daily_connection_limit?: number | null
          linkedin_daily_message_limit?: number | null
          linkedin_next_available_connection_at?: string | null
          linkedin_next_available_send_at?: string | null
          mailbox_identifier?: string | null
          mailbox_user_id?: string | null
          metadata?: Json | null
          microsoft_subscription_expires_at?: string | null
          microsoft_subscription_id?: string | null
          microsoft_user_id?: string | null
          next_available_send_at?: string | null
          owner_user_id?: string | null
          provider?: string
          rc_extension?: string | null
          rc_jwt?: string | null
          rc_phone_number?: string | null
          refresh_token?: string | null
          sending_window_end?: string
          sending_window_start?: string
          timezone?: string
          token_expires_at?: string | null
          unipile_account_id?: string | null
          unipile_provider?: string | null
          updated_at?: string
          user_id?: string | null
          webhook_subscription_id?: string | null
        }
        Relationships: []
      }
      interviews: {
        Row: {
          additional_interviewers: Json | null
          ai_confidence: number | null
          ai_sentiment: string | null
          ai_summary: string | null
          calendar_attendees: Json | null
          calendar_event_id: string | null
          calendar_event_url: string | null
          calendar_synced_at: string | null
          cancelled_at: string | null
          candidate_id: string | null
          completed_at: string | null
          created_at: string | null
          debrief_at: string | null
          debrief_notes: string | null
          debrief_source: string | null
          end_at: string | null
          id: string
          interview_type: string | null
          interviewer_company: string | null
          interviewer_contact_id: string | null
          interviewer_name: string | null
          interviewer_title: string | null
          job_id: string | null
          location: string | null
          meeting_link: string | null
          outcome: string | null
          owner_id: string | null
          round: number | null
          scheduled_at: string | null
          send_out_id: string | null
          stage: string
          timezone: string | null
          updated_at: string | null
        }
        Insert: {
          additional_interviewers?: Json | null
          ai_confidence?: number | null
          ai_sentiment?: string | null
          ai_summary?: string | null
          calendar_attendees?: Json | null
          calendar_event_id?: string | null
          calendar_event_url?: string | null
          calendar_synced_at?: string | null
          cancelled_at?: string | null
          candidate_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          debrief_at?: string | null
          debrief_notes?: string | null
          debrief_source?: string | null
          end_at?: string | null
          id?: string
          interview_type?: string | null
          interviewer_company?: string | null
          interviewer_contact_id?: string | null
          interviewer_name?: string | null
          interviewer_title?: string | null
          job_id?: string | null
          location?: string | null
          meeting_link?: string | null
          outcome?: string | null
          owner_id?: string | null
          round?: number | null
          scheduled_at?: string | null
          send_out_id?: string | null
          stage?: string
          timezone?: string | null
          updated_at?: string | null
        }
        Update: {
          additional_interviewers?: Json | null
          ai_confidence?: number | null
          ai_sentiment?: string | null
          ai_summary?: string | null
          calendar_attendees?: Json | null
          calendar_event_id?: string | null
          calendar_event_url?: string | null
          calendar_synced_at?: string | null
          cancelled_at?: string | null
          candidate_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          debrief_at?: string | null
          debrief_notes?: string | null
          debrief_source?: string | null
          end_at?: string | null
          id?: string
          interview_type?: string | null
          interviewer_company?: string | null
          interviewer_contact_id?: string | null
          interviewer_name?: string | null
          interviewer_title?: string | null
          job_id?: string | null
          location?: string | null
          meeting_link?: string | null
          outcome?: string | null
          owner_id?: string | null
          round?: number | null
          scheduled_at?: string | null
          send_out_id?: string | null
          stage?: string
          timezone?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "interviews_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_interviewer_contact_id_fkey"
            columns: ["interviewer_contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_interviewer_contact_id_fkey"
            columns: ["interviewer_contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_interviewer_contact_id_fkey"
            columns: ["interviewer_contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_interviewer_contact_id_fkey"
            columns: ["interviewer_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_interviewer_contact_id_fkey"
            columns: ["interviewer_contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interviews_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_candidate_matches: {
        Row: {
          blurb: string | null
          candidate_id: string
          concerns: Json | null
          created_at: string
          id: string
          job_id: string
          matched_at: string
          overall_score: number | null
          reasoning: string | null
          run_id: string | null
          score: number
          strengths: Json | null
          tier: string | null
          updated_at: string
          vector_similarity: number | null
        }
        Insert: {
          blurb?: string | null
          candidate_id: string
          concerns?: Json | null
          created_at?: string
          id?: string
          job_id: string
          matched_at?: string
          overall_score?: number | null
          reasoning?: string | null
          run_id?: string | null
          score?: number
          strengths?: Json | null
          tier?: string | null
          updated_at?: string
          vector_similarity?: number | null
        }
        Update: {
          blurb?: string | null
          candidate_id?: string
          concerns?: Json | null
          created_at?: string
          id?: string
          job_id?: string
          matched_at?: string
          overall_score?: number | null
          reasoning?: string | null
          run_id?: string | null
          score?: number
          strengths?: Json | null
          tier?: string | null
          updated_at?: string
          vector_similarity?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "job_candidate_matches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_candidate_matches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_candidate_matches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_candidate_matches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_candidate_matches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_candidate_matches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_contacts: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean | null
          job_id: string
          role: string
          updated_at: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          is_primary?: boolean | null
          job_id: string
          role?: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          is_primary?: boolean | null
          job_id?: string
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_contacts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_functions: {
        Row: {
          code: string
          created_at: string
          examples: string[]
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          examples?: string[]
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          examples?: string[]
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      job_match_runs: {
        Row: {
          candidates_scanned: number | null
          completed_at: string | null
          error_message: string | null
          id: string
          job_id: string | null
          matches_found: number | null
          started_at: string | null
          status: string
        }
        Insert: {
          candidates_scanned?: number | null
          completed_at?: string | null
          error_message?: string | null
          id?: string
          job_id?: string | null
          matches_found?: number | null
          started_at?: string | null
          status?: string
        }
        Update: {
          candidates_scanned?: number | null
          completed_at?: string | null
          error_message?: string | null
          id?: string
          job_id?: string | null
          matches_found?: number | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_match_runs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          additional_notes: string | null
          company_id: string | null
          company_name: string | null
          compensation: string | null
          contact_id: string | null
          created_at: string
          deleted_at: string | null
          deleted_by_user_id: string | null
          description: string | null
          id: string
          job_code: string | null
          job_function_id: string | null
          job_url: string | null
          location: string | null
          market_over: boolean
          num_openings: number
          status: string
          submittal_instructions: string | null
          title: string
          updated_at: string
        }
        Insert: {
          additional_notes?: string | null
          company_id?: string | null
          company_name?: string | null
          compensation?: string | null
          contact_id?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          description?: string | null
          id?: string
          job_code?: string | null
          job_function_id?: string | null
          job_url?: string | null
          location?: string | null
          market_over?: boolean
          num_openings?: number
          status?: string
          submittal_instructions?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          additional_notes?: string | null
          company_id?: string | null
          company_name?: string | null
          compensation?: string | null
          contact_id?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          description?: string | null
          id?: string
          job_code?: string | null
          job_function_id?: string | null
          job_url?: string | null
          location?: string | null
          market_over?: boolean
          num_openings?: number
          status?: string
          submittal_instructions?: string | null
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
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_job_function_id_fkey"
            columns: ["job_function_id"]
            isOneToOne: false
            referencedRelation: "job_functions"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_attendees: {
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
            foreignKeyName: "meeting_attendees_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          body: string
          category: string | null
          channel: string | null
          created_at: string
          created_by: string | null
          id: string
          is_shared: boolean
          name: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          body: string
          category?: string | null
          channel?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_shared?: boolean
          name: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          body?: string
          category?: string | null
          channel?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_shared?: boolean
          name?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          ai_tag_confidence: Json | null
          ai_tag_summary: string | null
          ai_tagged_at: string | null
          ai_tags: string[] | null
          attachments: Json
          body: string | null
          candidate_id: string | null
          channel: string
          channel_type: string | null
          contact_id: string | null
          conversation_id: string
          created_at: string
          direction: string
          extension: string | null
          external_conversation_id: string | null
          external_message_id: string | null
          external_thread_id: string | null
          from_identity: string | null
          id: string
          inserted_at: string | null
          integration_account_id: string | null
          is_read: boolean
          message_type: string | null
          owner_id: string | null
          provider: string | null
          provider_message_id: string | null
          raw_payload: Json | null
          received_at: string | null
          recipient_address: string | null
          role_context: string | null
          send_out_id: string | null
          sender_address: string | null
          sender_name: string | null
          sent_at: string | null
          subject: string | null
          to_identity: string | null
          topic: string | null
          unipile_chat_id: string | null
          unipile_message_id: string | null
          updated_at: string | null
        }
        Insert: {
          ai_tag_confidence?: Json | null
          ai_tag_summary?: string | null
          ai_tagged_at?: string | null
          ai_tags?: string[] | null
          attachments?: Json
          body?: string | null
          candidate_id?: string | null
          channel: string
          channel_type?: string | null
          contact_id?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          extension?: string | null
          external_conversation_id?: string | null
          external_message_id?: string | null
          external_thread_id?: string | null
          from_identity?: string | null
          id?: string
          inserted_at?: string | null
          integration_account_id?: string | null
          is_read?: boolean
          message_type?: string | null
          owner_id?: string | null
          provider?: string | null
          provider_message_id?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          recipient_address?: string | null
          role_context?: string | null
          send_out_id?: string | null
          sender_address?: string | null
          sender_name?: string | null
          sent_at?: string | null
          subject?: string | null
          to_identity?: string | null
          topic?: string | null
          unipile_chat_id?: string | null
          unipile_message_id?: string | null
          updated_at?: string | null
        }
        Update: {
          ai_tag_confidence?: Json | null
          ai_tag_summary?: string | null
          ai_tagged_at?: string | null
          ai_tags?: string[] | null
          attachments?: Json
          body?: string | null
          candidate_id?: string | null
          channel?: string
          channel_type?: string | null
          contact_id?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          extension?: string | null
          external_conversation_id?: string | null
          external_message_id?: string | null
          external_thread_id?: string | null
          from_identity?: string | null
          id?: string
          inserted_at?: string | null
          integration_account_id?: string | null
          is_read?: boolean
          message_type?: string | null
          owner_id?: string | null
          provider?: string | null
          provider_message_id?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          recipient_address?: string | null
          role_context?: string | null
          send_out_id?: string | null
          sender_address?: string | null
          sender_name?: string | null
          sent_at?: string | null
          subject?: string | null
          to_identity?: string | null
          topic?: string | null
          unipile_chat_id?: string | null
          unipile_message_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
            foreignKeyName: "messages_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
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
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
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
            foreignKeyName: "messages_integration_account_id_fkey"
            columns: ["integration_account_id"]
            isOneToOne: false
            referencedRelation: "integration_accounts"
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
          note_source: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          entity_id: string
          entity_type: string
          id?: string
          note: string
          note_source?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          note?: string
          note_source?: string
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
      oauth_states: {
        Row: {
          created_at: string
          provider: string
          state: string
          user_id: string
        }
        Insert: {
          created_at?: string
          provider?: string
          state: string
          user_id: string
        }
        Update: {
          created_at?: string
          provider?: string
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      people: {
        Row: {
          ai_search_text: string | null
          avatar_url: string | null
          back_of_resume: boolean
          back_of_resume_completed_at: string | null
          back_of_resume_notes: string | null
          back_of_resume_updated_at: string | null
          call_structured_notes: Json | null
          candidate_summary: string | null
          claimed_at: string | null
          comp_notes: string | null
          company_id: string | null
          company_name: string | null
          created_at: string
          created_by_user_id: string | null
          current_base_comp: number | null
          current_bonus_comp: number | null
          current_company: string | null
          current_title: string | null
          current_total_comp: number | null
          deleted_at: string | null
          deleted_by_user_id: string | null
          department: string | null
          disqualified_by: string | null
          disqualified_reason: string | null
          email_invalid: boolean
          email_invalid_at: string | null
          email_invalid_reason: string | null
          email_match_key: string | null
          first_name: string | null
          full_name: string | null
          fun_facts: string | null
          id: string
          identity_fingerprint: string | null
          inactive_reason: string | null
          is_stub: boolean
          job_id: string | null
          job_status: string | null
          joe_says: string | null
          joe_says_updated_at: string | null
          last_comm_channel: string | null
          last_contacted_at: string | null
          last_name: string | null
          last_responded_at: string | null
          last_sequence_sentiment: string | null
          last_sequence_sentiment_note: string | null
          last_spoken_at: string | null
          linked_contact_id: string | null
          linkedin_current_company: string | null
          linkedin_current_title: string | null
          linkedin_enriched_at: string | null
          linkedin_enrichment_source: string | null
          linkedin_headline: string | null
          linkedin_last_synced_at: string | null
          linkedin_location: string | null
          linkedin_match_key: string | null
          linkedin_profile_data: string | null
          linkedin_profile_text: string | null
          linkedin_url: string | null
          location_text: string | null
          mobile_phone: string | null
          normalized_email: string | null
          normalized_linkedin_url: string | null
          normalized_phone: string | null
          notes: string | null
          notice_period: string | null
          outlook_contact_id: string | null
          outlook_contact_synced_at: string | null
          owner_user_id: string | null
          personal_email: string | null
          phone: string | null
          phone_match_key: string | null
          placed_at: string | null
          primary_email: string | null
          profile_picture_url: string | null
          reason_for_leaving: string | null
          relocation_preference: string | null
          resume_url: string | null
          roles: string[]
          secondary_emails: string[]
          skills: string[] | null
          source: string | null
          source_detail: string | null
          stale_at: string | null
          status: string
          target_base_comp: number | null
          target_bonus_comp: number | null
          target_locations: string | null
          target_roles: string | null
          target_total_comp: number | null
          title: string | null
          type: string
          unipile_classic_id: string | null
          unipile_provider_id: string | null
          unipile_recruiter_id: string | null
          unipile_resolve_status: string | null
          unipile_sales_nav_id: string | null
          updated_at: string
          visa_status: string | null
          where_interviewed: string | null
          where_submitted: string | null
          work_authorization: string | null
          work_email: string | null
        }
        Insert: {
          ai_search_text?: string | null
          avatar_url?: string | null
          back_of_resume?: boolean
          back_of_resume_completed_at?: string | null
          back_of_resume_notes?: string | null
          back_of_resume_updated_at?: string | null
          call_structured_notes?: Json | null
          candidate_summary?: string | null
          claimed_at?: string | null
          comp_notes?: string | null
          company_id?: string | null
          company_name?: string | null
          created_at?: string
          created_by_user_id?: string | null
          current_base_comp?: number | null
          current_bonus_comp?: number | null
          current_company?: string | null
          current_title?: string | null
          current_total_comp?: number | null
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          department?: string | null
          disqualified_by?: string | null
          disqualified_reason?: string | null
          email_invalid?: boolean
          email_invalid_at?: string | null
          email_invalid_reason?: string | null
          email_match_key?: string | null
          first_name?: string | null
          full_name?: string | null
          fun_facts?: string | null
          id?: string
          identity_fingerprint?: string | null
          inactive_reason?: string | null
          is_stub?: boolean
          job_id?: string | null
          job_status?: string | null
          joe_says?: string | null
          joe_says_updated_at?: string | null
          last_comm_channel?: string | null
          last_contacted_at?: string | null
          last_name?: string | null
          last_responded_at?: string | null
          last_sequence_sentiment?: string | null
          last_sequence_sentiment_note?: string | null
          last_spoken_at?: string | null
          linked_contact_id?: string | null
          linkedin_current_company?: string | null
          linkedin_current_title?: string | null
          linkedin_enriched_at?: string | null
          linkedin_enrichment_source?: string | null
          linkedin_headline?: string | null
          linkedin_last_synced_at?: string | null
          linkedin_location?: string | null
          linkedin_match_key?: string | null
          linkedin_profile_data?: string | null
          linkedin_profile_text?: string | null
          linkedin_url?: string | null
          location_text?: string | null
          mobile_phone?: string | null
          normalized_email?: string | null
          normalized_linkedin_url?: string | null
          normalized_phone?: string | null
          notes?: string | null
          notice_period?: string | null
          outlook_contact_id?: string | null
          outlook_contact_synced_at?: string | null
          owner_user_id?: string | null
          personal_email?: string | null
          phone?: string | null
          phone_match_key?: string | null
          placed_at?: string | null
          primary_email?: string | null
          profile_picture_url?: string | null
          reason_for_leaving?: string | null
          relocation_preference?: string | null
          resume_url?: string | null
          roles?: string[]
          secondary_emails?: string[]
          skills?: string[] | null
          source?: string | null
          source_detail?: string | null
          stale_at?: string | null
          status?: string
          target_base_comp?: number | null
          target_bonus_comp?: number | null
          target_locations?: string | null
          target_roles?: string | null
          target_total_comp?: number | null
          title?: string | null
          type?: string
          unipile_classic_id?: string | null
          unipile_provider_id?: string | null
          unipile_recruiter_id?: string | null
          unipile_resolve_status?: string | null
          unipile_sales_nav_id?: string | null
          updated_at?: string
          visa_status?: string | null
          where_interviewed?: string | null
          where_submitted?: string | null
          work_authorization?: string | null
          work_email?: string | null
        }
        Update: {
          ai_search_text?: string | null
          avatar_url?: string | null
          back_of_resume?: boolean
          back_of_resume_completed_at?: string | null
          back_of_resume_notes?: string | null
          back_of_resume_updated_at?: string | null
          call_structured_notes?: Json | null
          candidate_summary?: string | null
          claimed_at?: string | null
          comp_notes?: string | null
          company_id?: string | null
          company_name?: string | null
          created_at?: string
          created_by_user_id?: string | null
          current_base_comp?: number | null
          current_bonus_comp?: number | null
          current_company?: string | null
          current_title?: string | null
          current_total_comp?: number | null
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          department?: string | null
          disqualified_by?: string | null
          disqualified_reason?: string | null
          email_invalid?: boolean
          email_invalid_at?: string | null
          email_invalid_reason?: string | null
          email_match_key?: string | null
          first_name?: string | null
          full_name?: string | null
          fun_facts?: string | null
          id?: string
          identity_fingerprint?: string | null
          inactive_reason?: string | null
          is_stub?: boolean
          job_id?: string | null
          job_status?: string | null
          joe_says?: string | null
          joe_says_updated_at?: string | null
          last_comm_channel?: string | null
          last_contacted_at?: string | null
          last_name?: string | null
          last_responded_at?: string | null
          last_sequence_sentiment?: string | null
          last_sequence_sentiment_note?: string | null
          last_spoken_at?: string | null
          linked_contact_id?: string | null
          linkedin_current_company?: string | null
          linkedin_current_title?: string | null
          linkedin_enriched_at?: string | null
          linkedin_enrichment_source?: string | null
          linkedin_headline?: string | null
          linkedin_last_synced_at?: string | null
          linkedin_location?: string | null
          linkedin_match_key?: string | null
          linkedin_profile_data?: string | null
          linkedin_profile_text?: string | null
          linkedin_url?: string | null
          location_text?: string | null
          mobile_phone?: string | null
          normalized_email?: string | null
          normalized_linkedin_url?: string | null
          normalized_phone?: string | null
          notes?: string | null
          notice_period?: string | null
          outlook_contact_id?: string | null
          outlook_contact_synced_at?: string | null
          owner_user_id?: string | null
          personal_email?: string | null
          phone?: string | null
          phone_match_key?: string | null
          placed_at?: string | null
          primary_email?: string | null
          profile_picture_url?: string | null
          reason_for_leaving?: string | null
          relocation_preference?: string | null
          resume_url?: string | null
          roles?: string[]
          secondary_emails?: string[]
          skills?: string[] | null
          source?: string | null
          source_detail?: string | null
          stale_at?: string | null
          status?: string
          target_base_comp?: number | null
          target_bonus_comp?: number | null
          target_locations?: string | null
          target_roles?: string | null
          target_total_comp?: number | null
          title?: string | null
          type?: string
          unipile_classic_id?: string | null
          unipile_provider_id?: string | null
          unipile_recruiter_id?: string | null
          unipile_resolve_status?: string | null
          unipile_sales_nav_id?: string | null
          updated_at?: string
          visa_status?: string | null
          where_interviewed?: string | null
          where_submitted?: string | null
          work_authorization?: string | null
          work_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
          {
            foreignKeyName: "candidates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      pitches: {
        Row: {
          candidate_id: string
          candidate_job_id: string | null
          created_at: string
          id: string
          job_id: string
          notes: string | null
          pitched_at: string
          pitched_by: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          candidate_job_id?: string | null
          created_at?: string
          id?: string
          job_id: string
          notes?: string | null
          pitched_at?: string
          pitched_by?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          candidate_job_id?: string | null
          created_at?: string
          id?: string
          job_id?: string
          notes?: string | null
          pitched_at?: string
          pitched_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pitches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitches_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitches_candidate_job_id_fkey"
            columns: ["candidate_job_id"]
            isOneToOne: false
            referencedRelation: "candidate_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pitches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      placements: {
        Row: {
          candidate_id: string | null
          contact_id: string | null
          created_at: string | null
          falloff: boolean | null
          falloff_date: string | null
          falloff_reason: string | null
          fee_amount: number | null
          fee_pct: number | null
          fee_type: string | null
          guarantee_days: number | null
          guarantee_end_date: string | null
          id: string
          invoice_date: string | null
          invoice_number: string | null
          invoice_status: string | null
          job_id: string | null
          notes: string | null
          payment_date: string | null
          placed_at: string | null
          replacement_candidate_id: string | null
          salary: number | null
          send_out_id: string | null
          start_date: string | null
          updated_at: string | null
        }
        Insert: {
          candidate_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          falloff?: boolean | null
          falloff_date?: string | null
          falloff_reason?: string | null
          fee_amount?: number | null
          fee_pct?: number | null
          fee_type?: string | null
          guarantee_days?: number | null
          guarantee_end_date?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          invoice_status?: string | null
          job_id?: string | null
          notes?: string | null
          payment_date?: string | null
          placed_at?: string | null
          replacement_candidate_id?: string | null
          salary?: number | null
          send_out_id?: string | null
          start_date?: string | null
          updated_at?: string | null
        }
        Update: {
          candidate_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          falloff?: boolean | null
          falloff_date?: string | null
          falloff_reason?: string | null
          fee_amount?: number | null
          fee_pct?: number | null
          fee_type?: string | null
          guarantee_days?: number | null
          guarantee_end_date?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          invoice_status?: string | null
          job_id?: string | null
          notes?: string | null
          payment_date?: string | null
          placed_at?: string | null
          replacement_candidate_id?: string | null
          salary?: number | null
          send_out_id?: string | null
          start_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "placements_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_replacement_candidate_id_fkey"
            columns: ["replacement_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_replacement_candidate_id_fkey"
            columns: ["replacement_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_replacement_candidate_id_fkey"
            columns: ["replacement_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_replacement_candidate_id_fkey"
            columns: ["replacement_candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_replacement_candidate_id_fkey"
            columns: ["replacement_candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placements_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          email_signature: string | null
          full_name: string | null
          id: string
          is_admin: boolean
          phone: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          email_signature?: string | null
          full_name?: string | null
          id: string
          is_admin?: boolean
          phone?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          email_signature?: string | null
          full_name?: string | null
          id?: string
          is_admin?: boolean
          phone?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rejections: {
        Row: {
          candidate_id: string
          candidate_job_id: string | null
          created_at: string
          id: string
          job_id: string
          notes: string | null
          prior_stage: string | null
          rejected_at: string
          rejected_by_party: string | null
          rejection_reason: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          candidate_job_id?: string | null
          created_at?: string
          id?: string
          job_id: string
          notes?: string | null
          prior_stage?: string | null
          rejected_at?: string
          rejected_by_party?: string | null
          rejection_reason?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          candidate_job_id?: string | null
          created_at?: string
          id?: string
          job_id?: string
          notes?: string | null
          prior_stage?: string | null
          rejected_at?: string
          rejected_by_party?: string | null
          rejection_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rejections_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rejections_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rejections_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rejections_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rejections_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rejections_candidate_job_id_fkey"
            columns: ["candidate_job_id"]
            isOneToOne: false
            referencedRelation: "candidate_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rejections_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      reply_sentiment: {
        Row: {
          analyzed_at: string | null
          candidate_id: string | null
          channel: string | null
          contact_id: string | null
          created_at: string | null
          enrollment_id: string | null
          id: string
          raw_message: string | null
          sentiment: string | null
          summary: string | null
        }
        Insert: {
          analyzed_at?: string | null
          candidate_id?: string | null
          channel?: string | null
          contact_id?: string | null
          created_at?: string | null
          enrollment_id?: string | null
          id?: string
          raw_message?: string | null
          sentiment?: string | null
          summary?: string | null
        }
        Update: {
          analyzed_at?: string | null
          candidate_id?: string | null
          channel?: string | null
          contact_id?: string | null
          created_at?: string | null
          enrollment_id?: string | null
          id?: string
          raw_message?: string | null
          sentiment?: string | null
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reply_sentiment_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reply_sentiment_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      resume_embeddings: {
        Row: {
          candidate_id: string
          chunk_index: number | null
          chunk_text: string | null
          created_at: string
          embed_model: string | null
          embed_type: string | null
          embedding: string | null
          id: string
          linkedin_embedded_at: string | null
          resume_id: string | null
          source_text: string
          updated_at: string
        }
        Insert: {
          candidate_id: string
          chunk_index?: number | null
          chunk_text?: string | null
          created_at?: string
          embed_model?: string | null
          embed_type?: string | null
          embedding?: string | null
          id?: string
          linkedin_embedded_at?: string | null
          resume_id?: string | null
          source_text: string
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          chunk_index?: number | null
          chunk_text?: string | null
          created_at?: string
          embed_model?: string | null
          embed_type?: string | null
          embedding?: string | null
          id?: string
          linkedin_embedded_at?: string | null
          resume_id?: string | null
          source_text?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "resume_embeddings_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_embeddings_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_embeddings_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_embeddings_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_embeddings_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      resumes: {
        Row: {
          ai_summary: string | null
          candidate_id: string | null
          created_at: string
          file_name: string | null
          file_path: string
          file_size: number | null
          file_url: string | null
          id: string
          mime_type: string | null
          parse_error: string | null
          parsed_json: Json | null
          parser: string | null
          parsing_status: string
          raw_text: string | null
          source: string | null
          source_message_id: string | null
          updated_at: string
        }
        Insert: {
          ai_summary?: string | null
          candidate_id?: string | null
          created_at?: string
          file_name?: string | null
          file_path: string
          file_size?: number | null
          file_url?: string | null
          id?: string
          mime_type?: string | null
          parse_error?: string | null
          parsed_json?: Json | null
          parser?: string | null
          parsing_status?: string
          raw_text?: string | null
          source?: string | null
          source_message_id?: string | null
          updated_at?: string
        }
        Update: {
          ai_summary?: string | null
          candidate_id?: string | null
          created_at?: string
          file_name?: string | null
          file_path?: string
          file_size?: number | null
          file_url?: string | null
          id?: string
          mime_type?: string | null
          parse_error?: string | null
          parsed_json?: Json | null
          parser?: string | null
          parsing_status?: string
          raw_text?: string | null
          source?: string | null
          source_message_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resumes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      search_documents: {
        Row: {
          body: string | null
          candidate_id: string | null
          company_id: string | null
          contact_id: string | null
          created_at: string
          embedding: string | null
          fts: unknown
          id: string
          indexed_at: string
          job_id: string | null
          metadata: Json
          person_id: string | null
          role_context: string | null
          send_out_id: string | null
          source_id: string
          source_kind: string
          source_updated_at: string | null
          subtitle: string | null
          task_id: string | null
          title: string
          updated_at: string
          url: string | null
        }
        Insert: {
          body?: string | null
          candidate_id?: string | null
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          embedding?: string | null
          fts?: unknown
          id?: string
          indexed_at?: string
          job_id?: string | null
          metadata?: Json
          person_id?: string | null
          role_context?: string | null
          send_out_id?: string | null
          source_id: string
          source_kind: string
          source_updated_at?: string | null
          subtitle?: string | null
          task_id?: string | null
          title: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          body?: string | null
          candidate_id?: string | null
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          embedding?: string | null
          fts?: unknown
          id?: string
          indexed_at?: string
          job_id?: string | null
          metadata?: Json
          person_id?: string | null
          role_context?: string | null
          send_out_id?: string | null
          source_id?: string
          source_kind?: string
          source_updated_at?: string | null
          subtitle?: string | null
          task_id?: string | null
          title?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "search_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
          {
            foreignKeyName: "search_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_send_out_id_fkey"
            columns: ["send_out_id"]
            isOneToOne: false
            referencedRelation: "send_outs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_documents_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      send_outs: {
        Row: {
          candidate_id: string
          candidate_job_id: string | null
          contact_id: string | null
          created_at: string
          deleted_at: string | null
          deleted_by_user_id: string | null
          feedback: string | null
          id: string
          interview_at: string | null
          interview_round: number | null
          job_id: string
          offer_at: string | null
          outcome: string | null
          placed_at: string | null
          recruiter_id: string | null
          rejected_by: string | null
          rejection_reason: string | null
          resume_file_name: string | null
          resume_url: string | null
          sent_to_client_at: string | null
          stage: string
          submittal_notes: string | null
          updated_at: string
          withdrawn_reason: string | null
        }
        Insert: {
          candidate_id: string
          candidate_job_id?: string | null
          contact_id?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          feedback?: string | null
          id?: string
          interview_at?: string | null
          interview_round?: number | null
          job_id: string
          offer_at?: string | null
          outcome?: string | null
          placed_at?: string | null
          recruiter_id?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          resume_file_name?: string | null
          resume_url?: string | null
          sent_to_client_at?: string | null
          stage?: string
          submittal_notes?: string | null
          updated_at?: string
          withdrawn_reason?: string | null
        }
        Update: {
          candidate_id?: string
          candidate_job_id?: string | null
          contact_id?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          feedback?: string | null
          id?: string
          interview_at?: string | null
          interview_round?: number | null
          job_id?: string
          offer_at?: string | null
          outcome?: string | null
          placed_at?: string | null
          recruiter_id?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          resume_file_name?: string | null
          resume_url?: string | null
          sent_to_client_at?: string | null
          stage?: string
          submittal_notes?: string | null
          updated_at?: string
          withdrawn_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_candidate_job_id_fkey"
            columns: ["candidate_job_id"]
            isOneToOne: false
            referencedRelation: "candidate_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_outs_contact_id_fkey"
            columns: ["contact_id"]
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
            foreignKeyName: "send_outs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
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
      sequence_actions: {
        Row: {
          attachment_url: string | null
          attachment_urls: string[]
          base_delay_hours: number
          channel: string
          created_at: string | null
          delay_interval_minutes: number
          id: string
          jiggle_minutes: number
          message_body: string | null
          node_id: string | null
          post_connection_hardcoded_hours: number | null
          reply_to_previous: boolean
          respect_send_window: boolean
          subject_line: string | null
          use_signature: boolean | null
        }
        Insert: {
          attachment_url?: string | null
          attachment_urls?: string[]
          base_delay_hours?: number
          channel: string
          created_at?: string | null
          delay_interval_minutes?: number
          id?: string
          jiggle_minutes?: number
          message_body?: string | null
          node_id?: string | null
          post_connection_hardcoded_hours?: number | null
          reply_to_previous?: boolean
          respect_send_window?: boolean
          subject_line?: string | null
          use_signature?: boolean | null
        }
        Update: {
          attachment_url?: string | null
          attachment_urls?: string[]
          base_delay_hours?: number
          channel?: string
          created_at?: string | null
          delay_interval_minutes?: number
          id?: string
          jiggle_minutes?: number
          message_body?: string | null
          node_id?: string | null
          post_connection_hardcoded_hours?: number | null
          reply_to_previous?: boolean
          respect_send_window?: boolean
          subject_line?: string | null
          use_signature?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_actions_node_id_fkey"
            columns: ["node_id"]
            isOneToOne: false
            referencedRelation: "sequence_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_branches: {
        Row: {
          after_days: number | null
          condition: string
          created_at: string | null
          from_node_id: string | null
          id: string
          to_node_id: string | null
        }
        Insert: {
          after_days?: number | null
          condition: string
          created_at?: string | null
          from_node_id?: string | null
          id?: string
          to_node_id?: string | null
        }
        Update: {
          after_days?: number | null
          condition?: string
          created_at?: string | null
          from_node_id?: string | null
          id?: string
          to_node_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_branches_from_node_id_fkey"
            columns: ["from_node_id"]
            isOneToOne: false
            referencedRelation: "sequence_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_branches_to_node_id_fkey"
            columns: ["to_node_id"]
            isOneToOne: false
            referencedRelation: "sequence_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_enrollments: {
        Row: {
          candidate_id: string | null
          contact_id: string | null
          current_node_id: string | null
          email_conversation_id: string | null
          email_last_message_id: string | null
          email_thread_subject: string | null
          enrolled_at: string | null
          enrolled_by: string | null
          id: string
          linkedin_connection_accepted_at: string | null
          linkedin_connection_requested_at: string | null
          linkedin_connection_status: string | null
          role_context: string | null
          sequence_id: string | null
          staggered_at: string | null
          status: string
          stop_reason: string | null
          stop_trigger: string | null
          stopped_at: string | null
          unipile_chat_id: string | null
          waiting_for_connection_acceptance: boolean | null
        }
        Insert: {
          candidate_id?: string | null
          contact_id?: string | null
          current_node_id?: string | null
          email_conversation_id?: string | null
          email_last_message_id?: string | null
          email_thread_subject?: string | null
          enrolled_at?: string | null
          enrolled_by?: string | null
          id?: string
          linkedin_connection_accepted_at?: string | null
          linkedin_connection_requested_at?: string | null
          linkedin_connection_status?: string | null
          role_context?: string | null
          sequence_id?: string | null
          staggered_at?: string | null
          status?: string
          stop_reason?: string | null
          stop_trigger?: string | null
          stopped_at?: string | null
          unipile_chat_id?: string | null
          waiting_for_connection_acceptance?: boolean | null
        }
        Update: {
          candidate_id?: string | null
          contact_id?: string | null
          current_node_id?: string | null
          email_conversation_id?: string | null
          email_last_message_id?: string | null
          email_thread_subject?: string | null
          enrolled_at?: string | null
          enrolled_by?: string | null
          id?: string
          linkedin_connection_accepted_at?: string | null
          linkedin_connection_requested_at?: string | null
          linkedin_connection_status?: string | null
          role_context?: string | null
          sequence_id?: string | null
          staggered_at?: string | null
          status?: string
          stop_reason?: string | null
          stop_trigger?: string | null
          stopped_at?: string | null
          unipile_chat_id?: string | null
          waiting_for_connection_acceptance?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_enrollments_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
            foreignKeyName: "sequence_enrollments_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_contact_id_fkey"
            columns: ["contact_id"]
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
            foreignKeyName: "sequence_enrollments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_current_node_id_fkey"
            columns: ["current_node_id"]
            isOneToOne: false
            referencedRelation: "sequence_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_enrollments_enrolled_by_fkey"
            columns: ["enrolled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      sequence_nodes: {
        Row: {
          branch_id: string
          branch_step_order: number | null
          created_at: string | null
          id: string
          label: string | null
          node_order: number
          node_type: string
          sequence_id: string | null
        }
        Insert: {
          branch_id?: string
          branch_step_order?: number | null
          created_at?: string | null
          id?: string
          label?: string | null
          node_order: number
          node_type: string
          sequence_id?: string | null
        }
        Update: {
          branch_id?: string
          branch_step_order?: number | null
          created_at?: string | null
          id?: string
          label?: string | null
          node_order?: number
          node_type?: string
          sequence_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_nodes_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_step_logs: {
        Row: {
          action_id: string | null
          channel: string | null
          created_at: string | null
          enrollment_id: string | null
          id: string
          internet_message_id: string | null
          node_id: string | null
          open_count: number
          opened_at: string | null
          reply_received_at: string | null
          reply_text: string | null
          scheduled_at: string | null
          sent_at: string | null
          sentiment: string | null
          sentiment_reason: string | null
          skip_reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          action_id?: string | null
          channel?: string | null
          created_at?: string | null
          enrollment_id?: string | null
          id?: string
          internet_message_id?: string | null
          node_id?: string | null
          open_count?: number
          opened_at?: string | null
          reply_received_at?: string | null
          reply_text?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          sentiment?: string | null
          sentiment_reason?: string | null
          skip_reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          action_id?: string | null
          channel?: string | null
          created_at?: string | null
          enrollment_id?: string | null
          id?: string
          internet_message_id?: string | null
          node_id?: string | null
          open_count?: number
          opened_at?: string | null
          reply_received_at?: string | null
          reply_text?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          sentiment?: string | null
          sentiment_reason?: string | null
          skip_reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_step_logs_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "sequence_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_step_logs_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "sequence_enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sequence_step_logs_node_id_fkey"
            columns: ["node_id"]
            isOneToOne: false
            referencedRelation: "sequence_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      sequences: {
        Row: {
          archived_at: string | null
          audience_type: string
          channel: string | null
          created_at: string | null
          created_by: string | null
          id: string
          job_id: string | null
          job_ids: string[]
          name: string
          objective: string | null
          send_window_end: string
          send_window_start: string
          sender_user_id: string | null
          status: string
          stop_on_reply: boolean
          timezone: string
          updated_at: string | null
          weekdays_only: boolean
        }
        Insert: {
          archived_at?: string | null
          audience_type: string
          channel?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          job_id?: string | null
          job_ids?: string[]
          name: string
          objective?: string | null
          send_window_end?: string
          send_window_start?: string
          sender_user_id?: string | null
          status?: string
          stop_on_reply?: boolean
          timezone?: string
          updated_at?: string | null
          weekdays_only?: boolean
        }
        Update: {
          archived_at?: string | null
          audience_type?: string
          channel?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          job_id?: string | null
          job_ids?: string[]
          name?: string
          objective?: string | null
          send_window_end?: string
          send_window_start?: string
          sender_user_id?: string | null
          status?: string
          stop_on_reply?: boolean
          timezone?: string
          updated_at?: string | null
          weekdays_only?: boolean
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
      sf_applicants: {
        Row: {
          compensation_exceptions: string
          created_at: string | null
          do_you_require_sponsorship_now_or_in_the_future_: string[]
          email: string
          id: number
          last_name: string
          linkedin_url: string
          phone: string
          title: string
          updated_at: string | null
        }
        Insert: {
          compensation_exceptions: string
          created_at?: string | null
          do_you_require_sponsorship_now_or_in_the_future_: string[]
          email: string
          id?: number
          last_name: string
          linkedin_url: string
          phone: string
          title: string
          updated_at?: string | null
        }
        Update: {
          compensation_exceptions?: string
          created_at?: string | null
          do_you_require_sponsorship_now_or_in_the_future_?: string[]
          email?: string
          id?: number
          last_name?: string
          linkedin_url?: string
          phone?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      stage_transitions: {
        Row: {
          ai_confidence: number | null
          ai_reasoning: string | null
          created_at: string | null
          entity_id: string
          entity_type: string
          from_stage: string | null
          id: string
          moved_by: string
          to_stage: string
          trigger_source: string | null
          triggered_by_message_id: string | null
          triggered_by_user_id: string | null
        }
        Insert: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          created_at?: string | null
          entity_id: string
          entity_type: string
          from_stage?: string | null
          id?: string
          moved_by: string
          to_stage: string
          trigger_source?: string | null
          triggered_by_message_id?: string | null
          triggered_by_user_id?: string | null
        }
        Update: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          created_at?: string | null
          entity_id?: string
          entity_type?: string
          from_stage?: string | null
          id?: string
          moved_by?: string
          to_stage?: string
          trigger_source?: string | null
          triggered_by_message_id?: string | null
          triggered_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stage_transitions_triggered_by_message_id_fkey"
            columns: ["triggered_by_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      status_change_log: {
        Row: {
          actor_user_id: string | null
          confidence: number | null
          created_at: string
          entity_id: string
          entity_type: string
          from_status: string | null
          id: string
          metadata: Json | null
          reasoning: string | null
          to_status: string
          triggered_by: string
        }
        Insert: {
          actor_user_id?: string | null
          confidence?: number | null
          created_at?: string
          entity_id: string
          entity_type: string
          from_status?: string | null
          id?: string
          metadata?: Json | null
          reasoning?: string | null
          to_status: string
          triggered_by?: string
        }
        Update: {
          actor_user_id?: string | null
          confidence?: number | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          from_status?: string | null
          id?: string
          metadata?: Json | null
          reasoning?: string | null
          to_status?: string
          triggered_by?: string
        }
        Relationships: []
      }
      submissions: {
        Row: {
          candidate_id: string
          candidate_job_id: string | null
          created_at: string
          id: string
          job_id: string
          notes: string | null
          submitted_at: string
          submitted_by: string | null
          submitted_to: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          candidate_job_id?: string | null
          created_at?: string
          id?: string
          job_id: string
          notes?: string | null
          submitted_at?: string
          submitted_by?: string | null
          submitted_to?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          candidate_job_id?: string | null
          created_at?: string
          id?: string
          job_id?: string
          notes?: string | null
          submitted_at?: string
          submitted_by?: string | null
          submitted_to?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "submissions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_candidate_job_id_fkey"
            columns: ["candidate_job_id"]
            isOneToOne: false
            referencedRelation: "candidate_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_job_id_fkey"
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
          calendar_event_id: string | null
          completed_at: string | null
          completed_by: string | null
          create_followup: boolean
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          end_time: string | null
          external_id: string | null
          id: string
          location: string | null
          meeting_provider: string | null
          meeting_url: string | null
          no_calendar_invites: boolean
          priority: string
          related_to_id: string | null
          related_to_type: string | null
          reminder: string | null
          source: string | null
          source_id: string | null
          source_type: string | null
          start_time: string | null
          status: string
          task_subtype: string | null
          task_type: string
          timezone: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          calendar_event_id?: string | null
          completed_at?: string | null
          completed_by?: string | null
          create_followup?: boolean
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          end_time?: string | null
          external_id?: string | null
          id?: string
          location?: string | null
          meeting_provider?: string | null
          meeting_url?: string | null
          no_calendar_invites?: boolean
          priority?: string
          related_to_id?: string | null
          related_to_type?: string | null
          reminder?: string | null
          source?: string | null
          source_id?: string | null
          source_type?: string | null
          start_time?: string | null
          status?: string
          task_subtype?: string | null
          task_type?: string
          timezone?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          calendar_event_id?: string | null
          completed_at?: string | null
          completed_by?: string | null
          create_followup?: boolean
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          end_time?: string | null
          external_id?: string | null
          id?: string
          location?: string | null
          meeting_provider?: string | null
          meeting_url?: string | null
          no_calendar_invites?: boolean
          priority?: string
          related_to_id?: string | null
          related_to_type?: string | null
          reminder?: string | null
          source?: string | null
          source_id?: string | null
          source_type?: string | null
          start_time?: string | null
          status?: string
          task_subtype?: string | null
          task_type?: string
          timezone?: string | null
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
      user_oauth_tokens: {
        Row: {
          access_token: string
          created_at: string
          display_name: string | null
          email_address: string | null
          expires_at: string
          id: string
          provider: string
          refresh_token: string | null
          scope: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          display_name?: string | null
          email_address?: string | null
          expires_at: string
          id?: string
          provider?: string
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          display_name?: string | null
          email_address?: string | null
          expires_at?: string
          id?: string
          provider?: string
          refresh_token?: string | null
          scope?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      candidate_embedding_status: {
        Row: {
          current_company: string | null
          current_title: string | null
          embed_model: string | null
          embedded_at: string | null
          full_name: string | null
          has_embedding: boolean | null
          id: string | null
          status: string | null
          updated_at: string | null
        }
        Relationships: []
      }
      candidate_summary: {
        Row: {
          current_company: string | null
          current_title: string | null
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
      candidates: {
        Row: {
          ai_search_text: string | null
          avatar_url: string | null
          back_of_resume: boolean | null
          back_of_resume_completed_at: string | null
          back_of_resume_notes: string | null
          back_of_resume_updated_at: string | null
          call_structured_notes: Json | null
          candidate_summary: string | null
          claimed_at: string | null
          comp_notes: string | null
          company_id: string | null
          company_name: string | null
          created_at: string | null
          created_by_user_id: string | null
          current_base_comp: number | null
          current_bonus_comp: number | null
          current_company: string | null
          current_title: string | null
          current_total_comp: number | null
          department: string | null
          disqualified_by: string | null
          disqualified_reason: string | null
          email: string | null
          email_match_key: string | null
          first_name: string | null
          full_name: string | null
          fun_facts: string | null
          id: string | null
          identity_fingerprint: string | null
          inactive_reason: string | null
          is_stub: boolean | null
          job_id: string | null
          job_status: string | null
          joe_says: string | null
          joe_says_updated_at: string | null
          last_comm_channel: string | null
          last_contacted_at: string | null
          last_name: string | null
          last_responded_at: string | null
          last_sequence_sentiment: string | null
          last_sequence_sentiment_note: string | null
          last_spoken_at: string | null
          linked_contact_id: string | null
          linkedin_current_company: string | null
          linkedin_current_title: string | null
          linkedin_enriched_at: string | null
          linkedin_enrichment_source: string | null
          linkedin_headline: string | null
          linkedin_last_synced_at: string | null
          linkedin_location: string | null
          linkedin_match_key: string | null
          linkedin_profile_data: string | null
          linkedin_profile_text: string | null
          linkedin_url: string | null
          location_text: string | null
          mobile_phone: string | null
          normalized_email: string | null
          normalized_linkedin_url: string | null
          normalized_phone: string | null
          notes: string | null
          owner_user_id: string | null
          personal_email: string | null
          phone: string | null
          phone_match_key: string | null
          placed_at: string | null
          profile_picture_url: string | null
          reason_for_leaving: string | null
          relocation_preference: string | null
          resume_url: string | null
          roles: string[] | null
          secondary_emails: string[] | null
          skills: string[] | null
          stale_at: string | null
          status: string | null
          target_base_comp: number | null
          target_bonus_comp: number | null
          target_locations: string | null
          target_roles: string | null
          target_total_comp: number | null
          title: string | null
          type: string | null
          unipile_classic_id: string | null
          unipile_provider_id: string | null
          unipile_recruiter_id: string | null
          unipile_resolve_status: string | null
          unipile_sales_nav_id: string | null
          updated_at: string | null
          visa_status: string | null
          where_interviewed: string | null
          where_submitted: string | null
          work_authorization: string | null
          work_email: string | null
        }
        Insert: {
          ai_search_text?: string | null
          avatar_url?: string | null
          back_of_resume?: boolean | null
          back_of_resume_completed_at?: string | null
          back_of_resume_notes?: string | null
          back_of_resume_updated_at?: string | null
          call_structured_notes?: Json | null
          candidate_summary?: string | null
          claimed_at?: string | null
          comp_notes?: string | null
          company_id?: string | null
          company_name?: string | null
          created_at?: string | null
          created_by_user_id?: string | null
          current_base_comp?: number | null
          current_bonus_comp?: number | null
          current_company?: string | null
          current_title?: string | null
          current_total_comp?: number | null
          department?: string | null
          disqualified_by?: string | null
          disqualified_reason?: string | null
          email?: string | null
          email_match_key?: string | null
          first_name?: string | null
          full_name?: string | null
          fun_facts?: string | null
          id?: string | null
          identity_fingerprint?: string | null
          inactive_reason?: string | null
          is_stub?: boolean | null
          job_id?: string | null
          job_status?: string | null
          joe_says?: string | null
          joe_says_updated_at?: string | null
          last_comm_channel?: string | null
          last_contacted_at?: string | null
          last_name?: string | null
          last_responded_at?: string | null
          last_sequence_sentiment?: string | null
          last_sequence_sentiment_note?: string | null
          last_spoken_at?: string | null
          linked_contact_id?: string | null
          linkedin_current_company?: string | null
          linkedin_current_title?: string | null
          linkedin_enriched_at?: string | null
          linkedin_enrichment_source?: string | null
          linkedin_headline?: string | null
          linkedin_last_synced_at?: string | null
          linkedin_location?: string | null
          linkedin_match_key?: string | null
          linkedin_profile_data?: string | null
          linkedin_profile_text?: string | null
          linkedin_url?: string | null
          location_text?: string | null
          mobile_phone?: string | null
          normalized_email?: string | null
          normalized_linkedin_url?: string | null
          normalized_phone?: string | null
          notes?: string | null
          owner_user_id?: string | null
          personal_email?: string | null
          phone?: string | null
          phone_match_key?: string | null
          placed_at?: string | null
          profile_picture_url?: string | null
          reason_for_leaving?: string | null
          relocation_preference?: string | null
          resume_url?: string | null
          roles?: string[] | null
          secondary_emails?: string[] | null
          skills?: string[] | null
          stale_at?: string | null
          status?: string | null
          target_base_comp?: number | null
          target_bonus_comp?: number | null
          target_locations?: string | null
          target_roles?: string | null
          target_total_comp?: number | null
          title?: string | null
          type?: string | null
          unipile_classic_id?: string | null
          unipile_provider_id?: string | null
          unipile_recruiter_id?: string | null
          unipile_resolve_status?: string | null
          unipile_sales_nav_id?: string | null
          updated_at?: string | null
          visa_status?: string | null
          where_interviewed?: string | null
          where_submitted?: string | null
          work_authorization?: string | null
          work_email?: string | null
        }
        Update: {
          ai_search_text?: string | null
          avatar_url?: string | null
          back_of_resume?: boolean | null
          back_of_resume_completed_at?: string | null
          back_of_resume_notes?: string | null
          back_of_resume_updated_at?: string | null
          call_structured_notes?: Json | null
          candidate_summary?: string | null
          claimed_at?: string | null
          comp_notes?: string | null
          company_id?: string | null
          company_name?: string | null
          created_at?: string | null
          created_by_user_id?: string | null
          current_base_comp?: number | null
          current_bonus_comp?: number | null
          current_company?: string | null
          current_title?: string | null
          current_total_comp?: number | null
          department?: string | null
          disqualified_by?: string | null
          disqualified_reason?: string | null
          email?: string | null
          email_match_key?: string | null
          first_name?: string | null
          full_name?: string | null
          fun_facts?: string | null
          id?: string | null
          identity_fingerprint?: string | null
          inactive_reason?: string | null
          is_stub?: boolean | null
          job_id?: string | null
          job_status?: string | null
          joe_says?: string | null
          joe_says_updated_at?: string | null
          last_comm_channel?: string | null
          last_contacted_at?: string | null
          last_name?: string | null
          last_responded_at?: string | null
          last_sequence_sentiment?: string | null
          last_sequence_sentiment_note?: string | null
          last_spoken_at?: string | null
          linked_contact_id?: string | null
          linkedin_current_company?: string | null
          linkedin_current_title?: string | null
          linkedin_enriched_at?: string | null
          linkedin_enrichment_source?: string | null
          linkedin_headline?: string | null
          linkedin_last_synced_at?: string | null
          linkedin_location?: string | null
          linkedin_match_key?: string | null
          linkedin_profile_data?: string | null
          linkedin_profile_text?: string | null
          linkedin_url?: string | null
          location_text?: string | null
          mobile_phone?: string | null
          normalized_email?: string | null
          normalized_linkedin_url?: string | null
          normalized_phone?: string | null
          notes?: string | null
          owner_user_id?: string | null
          personal_email?: string | null
          phone?: string | null
          phone_match_key?: string | null
          placed_at?: string | null
          profile_picture_url?: string | null
          reason_for_leaving?: string | null
          relocation_preference?: string | null
          resume_url?: string | null
          roles?: string[] | null
          secondary_emails?: string[] | null
          skills?: string[] | null
          stale_at?: string | null
          status?: string | null
          target_base_comp?: number | null
          target_bonus_comp?: number | null
          target_locations?: string | null
          target_roles?: string | null
          target_total_comp?: number | null
          title?: string | null
          type?: string | null
          unipile_classic_id?: string | null
          unipile_provider_id?: string | null
          unipile_recruiter_id?: string | null
          unipile_resolve_status?: string | null
          unipile_sales_nav_id?: string | null
          updated_at?: string | null
          visa_status?: string | null
          where_interviewed?: string | null
          where_submitted?: string | null
          work_authorization?: string | null
          work_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
          {
            foreignKeyName: "candidates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_channels: {
        Row: {
          account_id: string | null
          channel: string | null
          connection_status: string | null
          contact_id: string | null
          created_at: string | null
          external_conversation_id: string | null
          id: string | null
          is_connected: boolean | null
          last_synced_at: string | null
          provider_id: string | null
          unipile_id: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_channels_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "integration_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_channels_candidate_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          ai_search_text: string | null
          avatar_url: string | null
          company_id: string | null
          company_name: string | null
          created_at: string | null
          department: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string | null
          is_stub: boolean | null
          last_comm_channel: string | null
          last_contacted_at: string | null
          last_name: string | null
          last_reached_out_at: string | null
          last_replied_at: string | null
          last_responded_at: string | null
          last_sequence_sentiment: string | null
          last_sequence_sentiment_note: string | null
          linked_candidate_id: string | null
          linkedin_current_company: string | null
          linkedin_current_title: string | null
          linkedin_enriched_at: string | null
          linkedin_enrichment_source: string | null
          linkedin_headline: string | null
          linkedin_last_synced_at: string | null
          linkedin_location: string | null
          linkedin_profile_data: string | null
          linkedin_profile_text: string | null
          linkedin_search: unknown
          linkedin_url: string | null
          location: string | null
          mobile_phone: string | null
          notes: string | null
          owner_id: string | null
          owner_user_id: string | null
          personal_email: string | null
          phone: string | null
          profile_picture_url: string | null
          roles: string[] | null
          secondary_emails: string[] | null
          status: string | null
          title: string | null
          unipile_classic_id: string | null
          unipile_provider_id: string | null
          unipile_recruiter_id: string | null
          unipile_resolve_status: string | null
          unipile_sales_nav_id: string | null
          updated_at: string | null
          user_id: string | null
          work_email: string | null
        }
        Insert: {
          ai_search_text?: string | null
          avatar_url?: string | null
          company_id?: string | null
          company_name?: string | null
          created_at?: string | null
          department?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string | null
          is_stub?: boolean | null
          last_comm_channel?: string | null
          last_contacted_at?: string | null
          last_name?: string | null
          last_reached_out_at?: string | null
          last_replied_at?: string | null
          last_responded_at?: string | null
          last_sequence_sentiment?: string | null
          last_sequence_sentiment_note?: string | null
          linked_candidate_id?: string | null
          linkedin_current_company?: string | null
          linkedin_current_title?: string | null
          linkedin_enriched_at?: string | null
          linkedin_enrichment_source?: string | null
          linkedin_headline?: string | null
          linkedin_last_synced_at?: string | null
          linkedin_location?: string | null
          linkedin_profile_data?: string | null
          linkedin_profile_text?: string | null
          linkedin_search?: never
          linkedin_url?: string | null
          location?: string | null
          mobile_phone?: string | null
          notes?: string | null
          owner_id?: string | null
          owner_user_id?: string | null
          personal_email?: string | null
          phone?: string | null
          profile_picture_url?: string | null
          roles?: string[] | null
          secondary_emails?: string[] | null
          status?: string | null
          title?: string | null
          unipile_classic_id?: string | null
          unipile_provider_id?: string | null
          unipile_recruiter_id?: string | null
          unipile_resolve_status?: string | null
          unipile_sales_nav_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          work_email?: string | null
        }
        Update: {
          ai_search_text?: string | null
          avatar_url?: string | null
          company_id?: string | null
          company_name?: string | null
          created_at?: string | null
          department?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string | null
          is_stub?: boolean | null
          last_comm_channel?: string | null
          last_contacted_at?: string | null
          last_name?: string | null
          last_reached_out_at?: string | null
          last_replied_at?: string | null
          last_responded_at?: string | null
          last_sequence_sentiment?: string | null
          last_sequence_sentiment_note?: string | null
          linked_candidate_id?: string | null
          linkedin_current_company?: string | null
          linkedin_current_title?: string | null
          linkedin_enriched_at?: string | null
          linkedin_enrichment_source?: string | null
          linkedin_headline?: string | null
          linkedin_last_synced_at?: string | null
          linkedin_location?: string | null
          linkedin_profile_data?: string | null
          linkedin_profile_text?: string | null
          linkedin_search?: never
          linkedin_url?: string | null
          location?: string | null
          mobile_phone?: string | null
          notes?: string | null
          owner_id?: string | null
          owner_user_id?: string | null
          personal_email?: string | null
          phone?: string | null
          profile_picture_url?: string | null
          roles?: string[] | null
          secondary_emails?: string[] | null
          status?: string | null
          title?: string | null
          unipile_classic_id?: string | null
          unipile_provider_id?: string | null
          unipile_recruiter_id?: string | null
          unipile_resolve_status?: string | null
          unipile_sales_nav_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          work_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "v_company_primary_domain"
            referencedColumns: ["company_id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidates_linked_contact_id_fkey"
            columns: ["linked_candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_threads: {
        Row: {
          account_id: string | null
          candidate_id: string | null
          candidate_name: string | null
          channel: string | null
          contact_id: string | null
          contact_name: string | null
          external_conversation_id: string | null
          id: string | null
          integration_account_id: string | null
          is_archived: boolean | null
          is_read: boolean | null
          last_inbound_at: string | null
          last_inbound_preview: string | null
          last_message_at: string | null
          last_message_preview: string | null
          send_out_id: string | null
          sort_at: string | null
          subject: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
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
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_embedding_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "candidate_summary"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
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
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_integration_account_id_fkey"
            columns: ["integration_account_id"]
            isOneToOne: false
            referencedRelation: "integration_accounts"
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
      v_company_primary_domain: {
        Row: {
          company_id: string | null
          primary_domain: string | null
        }
        Relationships: []
      }
      v_person_activity: {
        Row: {
          activity_type: string | null
          actor_user_id: string | null
          details: Json | null
          happened_at: string | null
          person_id: string | null
          source_id: string | null
          source_table: string | null
          summary: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      can_send_after_connection: {
        Args: { p_enrollment_id: string }
        Returns: boolean
      }
      clear_candidates_import_staging: { Args: never; Returns: undefined }
      complete_call_with_notes: {
        Args: { p_call_id: string; p_notes: string; p_summary?: string }
        Returns: Json
      }
      find_or_create_conversation_for_inbound: {
        Args: {
          p_candidate_id: string
          p_channel: string
          p_integration_account_id: string
        }
        Returns: string
      }
      generate_job_code: { Args: { p_function_id: string }; Returns: string }
      get_complete_schema: { Args: never; Returns: Json }
      get_unlinked_resume_files: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          file_name: string
          file_path: string
          mime_type: string
        }[]
      }
      get_valid_senders_for_channel: {
        Args: { p_channel: string; p_message_type?: string }
        Returns: {
          account_label: string
          display_name: string
          email_address: string
          id: string
          provider: string
        }[]
      }
      import_candidates_from_json: {
        Args: { payload: Json }
        Returns: {
          inserted: number
          total: number
          updated: number
        }[]
      }
      import_contact: {
        Args: { p_owner_id: string; p_row: Json }
        Returns: undefined
      }
      increment_step_log_open: { Args: { p_id: string }; Returns: undefined }
      is_consumer_email_domain: { Args: { addr: string }; Returns: boolean }
      is_current_user_admin: { Args: never; Returns: boolean }
      list_orphan_resume_files: {
        Args: { p_limit?: number; p_since?: string }
        Returns: {
          created_at: string
          name: string
        }[]
      }
      make_match_key: { Args: { p_value: string }; Returns: string }
      mark_candidate_back_of_resume: {
        Args: { p_candidate_id: string }
        Returns: undefined
      }
      match_call_notes: {
        Args: {
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          ai_summary: string
          candidate_id: string
          contact_id: string
          created_at: string
          note_id: string
          similarity: number
        }[]
      }
      match_call_to_person: {
        Args: { p_phone: string }
        Returns: {
          candidate_id: string
          contact_id: string
        }[]
      }
      match_candidates: {
        Args: {
          filter_status?: string
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          candidate_id: string
          current_company: string
          current_title: string
          data_quality: string
          embed_type: string
          full_name: string
          has_linkedin: boolean
          has_resume: boolean
          location_text: string
          similarity: number
          source_text: string
          status: string
        }[]
      }
      match_candidates_enriched: {
        Args: {
          filter_status?: string
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          candidate_id: string
          current_company: string
          current_title: string
          embed_type: string
          full_name: string
          location_text: string
          similarity: number
          source_text: string
          status: string
        }[]
      }
      match_candidates_for_job: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          candidate_id: string
          similarity: number
        }[]
      }
      match_contacts: {
        Args: {
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          company_name: string
          contact_id: string
          full_name: string
          similarity: number
          source_text: string
          title: string
        }[]
      }
      match_phone_and_link_call: {
        Args: { p_call_id: string; p_phone_number: string }
        Returns: Json
      }
      match_resume_chunks: {
        Args: {
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          candidate_id: string
          content: string
          id: string
          resume_id: string
          similarity: number
        }[]
      }
      match_resume_embeddings: {
        Args: {
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          candidate_id: string
          chunk_text: string
          resume_id: string
          similarity: number
          source_text: string
        }[]
      }
      match_search_documents: {
        Args: {
          filter_kinds?: string[]
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          body: string
          id: string
          metadata: Json
          role_context: string
          similarity: number
          source_id: string
          source_kind: string
          subtitle: string
          title: string
          url: string
        }[]
      }
      merge_candidate: {
        Args: { p_merged_id: string; p_survivor_id: string }
        Returns: string
      }
      merge_candidates_import_staging: { Args: never; Returns: Json }
      merge_staging_into_candidate: {
        Args: { p_candidate_id: string; p_staging_id: string }
        Returns: string
      }
      normalize_email: { Args: { p_value: string }; Returns: string }
      normalize_linkedin_url: { Args: { p_value: string }; Returns: string }
      normalize_phone: { Args: { p_value: string }; Returns: string }
      normalize_us_phone: { Args: { raw: string }; Returns: string }
      process_inbound_email: {
        Args: {
          p_body: string
          p_from_email: string
          p_from_name: string
          p_provider_message_id?: string
          p_received_at?: string
          p_subject: string
          p_to_email: string
        }
        Returns: string
      }
      promote_staging_to_new_candidate: {
        Args: { p_staging_id: string }
        Returns: string
      }
      purge_soft_deleted: { Args: never; Returns: undefined }
      search_resumes: {
        Args: { match_count?: number; query_embedding: string }
        Returns: {
          candidate_id: string
          current_company: string
          current_title: string
          full_name: string
          similarity: number
        }[]
      }
      search_resumes_by_embedding: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          candidate_id: string
          similarity: number
          source_text: string
        }[]
      }
      search_search_documents: {
        Args: {
          filter_kinds?: string[]
          match_count?: number
          search_query: string
        }
        Returns: {
          body: string
          id: string
          metadata: Json
          role_context: string
          score: number
          source_id: string
          source_kind: string
          subtitle: string
          title: string
          url: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      stop_active_sequences_for_person: {
        Args: {
          p_candidate_id: string
          p_channel: string
          p_contact_id: string
          p_message_id: string
          p_reason?: string
        }
        Returns: number
      }
      upsert_candidate_from_email: {
        Args: {
          candidate_data: Json
          source_email: string
          source_filename: string
        }
        Returns: Json
      }
      upsert_candidate_from_resume: {
        Args: {
          p_current_company?: string
          p_current_title?: string
          p_email?: string
          p_first_name: string
          p_last_name: string
          p_linkedin_url?: string
          p_location?: string
          p_owner_user_id: string
          p_phone?: string
          p_resume_url?: string
        }
        Returns: string
      }
      upsert_contact_from_csv: {
        Args: {
          p_company_name: string
          p_email: string
          p_first_name: string
          p_last_name: string
          p_linkedin_url: string
          p_title: string
        }
        Returns: string
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
