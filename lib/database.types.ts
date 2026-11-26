export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          contact: Record<string, unknown>;
          locale: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string;
          contact?: Record<string, unknown>;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          display_name?: string;
          contact?: Record<string, unknown>;
          locale?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      experiences: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          kind: string | null;
          summary: string | null;
          status: "active" | "archived";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          kind?: string | null;
          summary?: string | null;
          status?: "active" | "archived";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          name?: string;
          kind?: string | null;
          summary?: string | null;
          status?: "active" | "archived";
          updated_at?: string;
        };
        Relationships: [];
      };
      materials: {
        Row: {
          id: string;
          user_id: string;
          experience_id: string;
          type: "web" | "github" | "note" | "voice" | "image" | "file";
          source_url: string | null;
          object_key: string | null;
          text_content: string | null;
          original_filename: string | null;
          mime_type: string | null;
          size_bytes: number | null;
          content_hash: string | null;
          processing_status: "queued" | "processing" | "ready" | "failed";
          error_code: string | null;
          current_revision_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          experience_id: string;
          type: "web" | "github" | "note" | "voice" | "image" | "file";
          source_url?: string | null;
          object_key?: string | null;
          text_content?: string | null;
          original_filename?: string | null;
          mime_type?: string | null;
          size_bytes?: number | null;
          content_hash?: string | null;
          processing_status?: "queued" | "processing" | "ready" | "failed";
          error_code?: string | null;
          current_revision_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          processing_status?: "queued" | "processing" | "ready" | "failed";
          error_code?: string | null;
          current_revision_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      ai_credentials: {
        Row: {
          id: string;
          user_id: string;
          provider: string;
          label: string | null;
          model: string | null;
          endpoint: string;
          protocol: string;
          last_four: string | null;
          ciphertext: string;
          nonce: string;
          wrapped_dek: string;
          wrapped_dek_nonce: string;
          wrapped_dek_tag: string;
          kek_version: string;
          status: "active" | "deleting";
          created_at: string;
          updated_at: string;
          rotated_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          provider: string;
          label?: string | null;
          model?: string | null;
          endpoint: string;
          protocol: string;
          last_four?: string | null;
          ciphertext: string;
          nonce: string;
          wrapped_dek: string;
          wrapped_dek_nonce: string;
          wrapped_dek_tag: string;
          kek_version: string;
          status?: "active" | "deleting";
          created_at?: string;
          updated_at?: string;
          rotated_at?: string | null;
        };
        Update: {
          provider?: string;
          label?: string | null;
          model?: string | null;
          endpoint?: string;
          protocol?: string;
          last_four?: string | null;
          ciphertext?: string;
          nonce?: string;
          wrapped_dek?: string;
          wrapped_dek_nonce?: string;
          wrapped_dek_tag?: string;
          kek_version?: string;
          status?: "active" | "deleting";
          rotated_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      material_revisions: {
        Row: {
          id: string;
          material_id: string;
          user_id: string;
          revision_no: number;
          content_hash: string;
          parser_version: string | null;
          parse_status: "stored" | "parsing" | "ready" | "unsupported" | "needs_user_input" | "failed";
          error_code: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          material_id: string;
          user_id: string;
          revision_no: number;
          content_hash: string;
          parser_version?: string | null;
          parse_status?: "stored" | "parsing" | "ready" | "unsupported" | "needs_user_input" | "failed";
          error_code?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          parser_version?: string | null;
          parse_status?: "stored" | "parsing" | "ready" | "unsupported" | "needs_user_input" | "failed";
          error_code?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      material_segments: {
        Row: {
          id: string;
          revision_id: string;
          user_id: string;
          sequence: number;
          text_content: string;
          content_hash: string;
          source_locator: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          revision_id: string;
          user_id: string;
          sequence: number;
          text_content: string;
          content_hash: string;
          source_locator?: Record<string, unknown>;
          created_at?: string;
        };
        Update: {
          sequence?: number;
          text_content?: string;
          content_hash?: string;
          source_locator?: Record<string, unknown>;
        };
        Relationships: [];
      };
      processing_jobs: {
        Row: {
          id: string;
          user_id: string;
          kind: "fetch_web" | "parse_file" | "normalize_note" | "extract_claims" | "delete_material" | "delete_experience" | "delete_account" | "reap_temporary_data";
          target_id: string | null;
          status: "queued" | "running" | "completed" | "failed" | "canceled";
          idempotency_key: string;
          attempt: number;
          lease_token: string | null;
          lease_expires_at: string | null;
          error_code: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: "fetch_web" | "parse_file" | "normalize_note" | "extract_claims" | "delete_material" | "delete_experience" | "delete_account" | "reap_temporary_data";
          target_id?: string | null;
          status?: "queued" | "running" | "completed" | "failed" | "canceled";
          idempotency_key: string;
          attempt?: number;
          lease_token?: string | null;
          lease_expires_at?: string | null;
          error_code?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          target_id?: string | null;
          status?: "queued" | "running" | "completed" | "failed" | "canceled";
          attempt?: number;
          lease_token?: string | null;
          lease_expires_at?: string | null;
          error_code?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      extraction_consents: {
        Row: {
          id: string;
          user_id: string;
          material_revision_id: string;
          credential_id: string | null;
          provider: string;
          model: string;
          endpoint: string;
          protocol: string;
          adapter_id: string | null;
          adapter_version: string | null;
          prompt_version: string;
          schema_version: string;
          payload_hash: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          material_revision_id: string;
          credential_id?: string | null;
          provider: string;
          model: string;
          endpoint: string;
          protocol: string;
          adapter_id?: string | null;
          adapter_version?: string | null;
          prompt_version: string;
          schema_version: string;
          payload_hash: string;
          created_at?: string;
        };
        Update: {
          material_revision_id?: string;
          credential_id?: string | null;
          provider?: string;
          model?: string;
          endpoint?: string;
          protocol?: string;
          adapter_id?: string | null;
          adapter_version?: string | null;
          prompt_version?: string;
          schema_version?: string;
          payload_hash?: string;
        };
        Relationships: [];
      };
      extraction_consent_segments: {
        Row: {
          consent_id: string;
          segment_id: string;
          revision_id: string;
          user_id: string;
        };
        Insert: {
          consent_id: string;
          segment_id: string;
          revision_id: string;
          user_id: string;
        };
        Update: {
          consent_id?: string;
          segment_id?: string;
          revision_id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      extraction_runs: {
        Row: {
          id: string;
          user_id: string;
          consent_id: string;
          credential_id: string | null;
          provider: string;
          model: string;
          endpoint: string;
          protocol: string;
          adapter_id: string | null;
          adapter_version: string | null;
          prompt_version: string;
          schema_version: string;
          parser_version: string | null;
          pipeline_version: string | null;
          status: "queued" | "running" | "validating" | "completed" | "partial" | "failed" | "outcome_unknown";
          usage: Record<string, unknown> | null;
          attempts: number;
          error_code: string | null;
          started_at: string | null;
          finished_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          consent_id: string;
          credential_id?: string | null;
          provider: string;
          model: string;
          endpoint: string;
          protocol: string;
          adapter_id?: string | null;
          adapter_version?: string | null;
          prompt_version: string;
          schema_version: string;
          parser_version?: string | null;
          pipeline_version?: string | null;
          status?: "queued" | "running" | "validating" | "completed" | "partial" | "failed" | "outcome_unknown";
          usage?: Record<string, unknown> | null;
          attempts?: number;
          error_code?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          credential_id?: string | null;
          status?: "queued" | "running" | "validating" | "completed" | "partial" | "failed" | "outcome_unknown";
          usage?: Record<string, unknown> | null;
          attempts?: number;
          error_code?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      claims: {
        Row: {
          id: string;
          user_id: string;
          experience_id: string;
          run_id: string | null;
          origin: "ai" | "user";
          category: "project" | "organization" | "role" | "action" | "technology" | "outcome" | "metric" | "date" | "skill" | "learning" | "other";
          claim_text: string;
          review_state: "pending" | "confirmed" | "rejected";
          version: number;
          confirmed_at: string | null;
          confirmed_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          experience_id: string;
          run_id?: string | null;
          origin?: "ai" | "user";
          category?: "project" | "organization" | "role" | "action" | "technology" | "outcome" | "metric" | "date" | "skill" | "learning" | "other";
          claim_text: string;
          review_state?: "pending" | "confirmed" | "rejected";
          version?: number;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          experience_id?: string;
          run_id?: string | null;
          origin?: "ai" | "user";
          category?: "project" | "organization" | "role" | "action" | "technology" | "outcome" | "metric" | "date" | "skill" | "learning" | "other";
          claim_text?: string;
          review_state?: "pending" | "confirmed" | "rejected";
          version?: number;
          confirmed_at?: string | null;
          confirmed_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      claim_revisions: {
        Row: {
          id: string;
          claim_id: string;
          user_id: string;
          previous_text: string | null;
          new_text: string;
          actor: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          claim_id: string;
          user_id: string;
          previous_text?: string | null;
          new_text: string;
          actor: string;
          created_at?: string;
        };
        Update: {
          claim_id?: string;
          user_id?: string;
          previous_text?: string | null;
          new_text?: string;
          actor?: string;
        };
        Relationships: [];
      };
      claim_evidence: {
        Row: {
          id: string;
          claim_id: string;
          segment_id: string;
          run_id: string;
          user_id: string;
          quote: string;
          offsets: Record<string, unknown>;
          content_hash: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          claim_id: string;
          segment_id: string;
          run_id: string;
          user_id: string;
          quote: string;
          offsets?: Record<string, unknown>;
          content_hash: string;
          created_at?: string;
        };
        Update: {
          claim_id?: string;
          segment_id?: string;
          run_id?: string;
          user_id?: string;
          quote?: string;
          offsets?: Record<string, unknown>;
          content_hash?: string;
        };
        Relationships: [];
      };
      deletion_jobs: {
        Row: {
          id: string;
          user_id: string;
          target_type: "material" | "experience" | "account" | "credential";
          target_id: string;
          status: "queued" | "running" | "completed" | "failed";
          stage: string | null;
          pending_object_keys: string[];
          attempt: number;
          error_code: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          target_type: "material" | "experience" | "account" | "credential";
          target_id: string;
          status?: "queued" | "running" | "completed" | "failed";
          stage?: string | null;
          pending_object_keys?: string[];
          attempt?: number;
          error_code?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          target_type?: "material" | "experience" | "account" | "credential";
          target_id?: string;
          status?: "queued" | "running" | "completed" | "failed";
          stage?: string | null;
          pending_object_keys?: string[];
          attempt?: number;
          error_code?: string | null;
          completed_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      create_material_revision: {
        Args: {
          p_user_id: string;
          p_material_id: string;
          p_content_hash: string;
          p_kind: string;
        };
        Returns: Array<{
          revision_id: string;
          revision_no: number;
          job_id: string | null;
          created: boolean;
        }>;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
