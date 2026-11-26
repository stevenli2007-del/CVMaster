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
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          processing_status?: "queued" | "processing" | "ready" | "failed";
          error_code?: string | null;
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
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
