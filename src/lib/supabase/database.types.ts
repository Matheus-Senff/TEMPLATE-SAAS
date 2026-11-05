// Shape of supabase/migrations (public schema). Regenerate after every migration with the local stack running:
// npm run db:types. CI ("Banco real") compares this file with the types generated from a real database.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: { PostgrestVersion: "13.0.5" };
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string;
          actor_id: string | null;
          created_at: string;
          entity: string;
          entity_id: string | null;
          id: string;
          ip: string | null;
          metadata: Json | null;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          created_at?: string;
          entity: string;
          entity_id?: string | null;
          id?: string;
          ip?: string | null;
          metadata?: Json | null;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          created_at?: string;
          entity?: string;
          entity_id?: string | null;
          id?: string;
          ip?: string | null;
          metadata?: Json | null;
        };
        Relationships: [];
      };
      feature_flags: {
        Row: { description: string | null; enabled: boolean; key: string; updated_at: string };
        Insert: { description?: string | null; enabled?: boolean; key: string; updated_at?: string };
        Update: { description?: string | null; enabled?: boolean; key?: string; updated_at?: string };
        Relationships: [];
      };
      invitations: {
        Row: {
          accepted_at: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          org_id: string;
          role: string;
          token_hash: string;
        };
        Insert: {
          accepted_at?: string | null;
          created_at?: string;
          email: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          org_id: string;
          role?: string;
          token_hash: string;
        };
        Update: {
          accepted_at?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          org_id?: string;
          role?: string;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invitations_invited_by_fkey";
            columns: ["invited_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invitations_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      jobs: {
        Row: {
          attempts: number;
          created_at: string;
          id: string;
          idempotency_key: string | null;
          last_error: string | null;
          locked_at: string | null;
          max_attempts: number;
          payload: NonNullable<Json>;
          run_at: string;
          status: string;
          type: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          attempts?: number;
          created_at?: string;
          id?: string;
          idempotency_key?: string | null;
          last_error?: string | null;
          locked_at?: string | null;
          max_attempts?: number;
          payload?: NonNullable<Json>;
          run_at?: string;
          status?: string;
          type: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          attempts?: number;
          created_at?: string;
          id?: string;
          idempotency_key?: string | null;
          last_error?: string | null;
          locked_at?: string | null;
          max_attempts?: number;
          payload?: NonNullable<Json>;
          run_at?: string;
          status?: string;
          type?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      memberships: {
        Row: { created_at: string; org_id: string; role: string; user_id: string };
        Insert: { created_at?: string; org_id: string; role?: string; user_id: string };
        Update: { created_at?: string; org_id?: string; role?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "memberships_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          body: string | null;
          created_at: string;
          id: string;
          idempotency_key: string | null;
          link: string | null;
          read_at: string | null;
          title: string;
          type: string;
          user_id: string;
        };
        Insert: {
          body?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string | null;
          link?: string | null;
          read_at?: string | null;
          title: string;
          type?: string;
          user_id: string;
        };
        Update: {
          body?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string | null;
          link?: string | null;
          read_at?: string | null;
          title?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          personal_owner_id: string | null;
          stripe_customer_id: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          personal_owner_id?: string | null;
          stripe_customer_id?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          personal_owner_id?: string | null;
          stripe_customer_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organizations_personal_owner_id_fkey";
            columns: ["personal_owner_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          admin_since: string | null;
          created_at: string;
          email: string | null;
          full_name: string | null;
          id: string;
          role: string;
          updated_at: string;
        };
        Insert: {
          admin_since?: string | null;
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          id: string;
          role?: string;
          updated_at?: string;
        };
        Update: {
          admin_since?: string | null;
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          id?: string;
          role?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      rate_limits: {
        Row: { count: number; key: string; reset_at: string };
        Insert: { count: number; key: string; reset_at: string };
        Update: { count?: number; key?: string; reset_at?: string };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean;
          created_at: string;
          current_period_end: string | null;
          id: string;
          org_id: string;
          price_id: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          cancel_at_period_end?: boolean;
          created_at?: string;
          current_period_end?: string | null;
          id: string;
          org_id: string;
          price_id?: string | null;
          status: string;
          updated_at?: string;
        };
        Update: {
          cancel_at_period_end?: boolean;
          created_at?: string;
          current_period_end?: string | null;
          id?: string;
          org_id?: string;
          price_id?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_org_id_fkey";
            columns: ["org_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      webhook_events: {
        Row: { created_at: string; id: string; processed_at: string | null; source: string; type: string };
        Insert: { created_at?: string; id: string; processed_at?: string | null; source: string; type: string };
        Update: { created_at?: string; id?: string; processed_at?: string | null; source?: string; type?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      admin_mfa_trusted: { Args: Record<PropertyKey, never>; Returns: boolean };
      claim_jobs: {
        Args: { p_limit?: number; p_lock_seconds?: number };
        Returns: Database["public"]["Tables"]["jobs"]["Row"][];
      };
      cleanup_old_records: { Args: Record<PropertyKey, never>; Returns: Json };
      complete_job: { Args: { p_id: string }; Returns: undefined };
      fail_job: { Args: { p_error: string; p_id: string; p_retry_in_seconds: number }; Returns: string };
      has_active_subscription: { Args: { org: string }; Returns: boolean };
      has_org_role: { Args: { org: string; role: string }; Returns: boolean };
      has_verified_mfa: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_org_member: { Args: { org: string }; Returns: boolean };
      mfa_satisfied: { Args: Record<PropertyKey, never>; Returns: boolean };
      my_org_ids: { Args: { min_role?: string }; Returns: string[] };
      org_role_rank: { Args: { role: string }; Returns: number };
      rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number };
        Returns: { allowed: boolean; remaining: number; reset_at: string }[];
      };
      rate_limit_peek: { Args: { p_key: string; p_limit: number }; Returns: boolean };
      retry_job: { Args: { p_id: string }; Returns: undefined };
      storage_quota_bytes: { Args: Record<PropertyKey, never>; Returns: number };
      storage_quota_files: { Args: Record<PropertyKey, never>; Returns: number };
      storage_write_allowed: { Args: { p_name: string; p_new_size: number }; Returns: boolean };
      user_has_verified_mfa: { Args: { p_user: string }; Returns: boolean };
      user_storage_bytes: { Args: Record<PropertyKey, never>; Returns: number };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type PublicSchema = Database["public"];
export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"];
