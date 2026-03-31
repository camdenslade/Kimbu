import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinTable,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// ============================================
// 1. USERS (Global Identity)
// ============================================

@Entity('users')
@Index(['email'], { unique: true })
@Index(['created_at'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar')
  email!: string;

  @Column('varchar', { nullable: true })
  phone?: string;

  @Column('varchar', { nullable: true })
  name?: string;

  @Column('varchar', { nullable: true })
  avatar_url?: string;

  @Column('boolean', { default: false })
  email_verified!: boolean;

  @Column('boolean', { default: false })
  phone_verified!: boolean;

  @Column('varchar', { default: 'active' })
  status!: 'active' | 'suspended' | 'deleted';

  @Column('jsonb', { default: {} })
  metadata!: Record<string, any>;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @Column('timestamp', { nullable: true })
  deleted_at?: Date;

  // Relations
  @OneToMany(() => Identity, (identity) => identity.user, { eager: false })
  identities!: Identity[];

  @OneToMany(() => UserApp, (userApp) => userApp.user)
  app_memberships!: UserApp[];

  @OneToMany(() => Session, (session) => session.user)
  sessions!: Session[];
}

// ============================================
// 2. IDENTITIES (Multiple Login Methods Per User)
// ============================================

@Entity('identities')
@Index(['identity_type', 'provider_id'], { unique: true })
@Index(['user_id', 'identity_type'])
@Index(['email'])
@Index(['phone'])
export class Identity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  user_id!: string;

  @Column('varchar')
  identity_type!: 'email' | 'phone' | 'google' | 'apple' | 'github';

  @Column('varchar', { nullable: true })
  email?: string;

  @Column('varchar', { nullable: true })
  phone?: string;

  // OAuth provider ID (e.g., Google sub, Apple user_id)
  @Column('varchar', { nullable: true })
  provider_id?: string;

  // For email/password identities
  @Column('varchar', { nullable: true })
  password_hash?: string;

  @Column('boolean', { default: false })
  is_primary!: boolean;

  @Column('boolean', { default: true })
  is_verified!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.identities, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}

// ============================================
// 3. APPS (Tenants/Multi-Tenant Support)
// ============================================

@Entity('apps')
@Index(['owner_id'])
@Index(['created_at'])
export class App {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar')
  name!: string;

  @Column('varchar', { nullable: true })
  description?: string;

  @Column('uuid')
  owner_id!: string; // User who owns/created the app

  @Column('varchar')
  slug!: string; // URL-friendly name

  @Column('varchar', { default: 'active' })
  status!: 'active' | 'suspended' | 'deleted';

  // API Keys for integration
  @Column('varchar', { nullable: true })
  api_key!: string;

  @Column('varchar', { nullable: true })
  api_secret!: string;

  // Configuration
  @Column('jsonb', { default: {} })
  config!: {
    oauth_redirect_uris?: string[];
    webhook_urls?: string[];
    mfa_required?: boolean;
    session_duration_hours?: number;
  };

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relations
  @OneToMany(() => UserApp, (userApp) => userApp.app)
  user_memberships!: UserApp[];

  @OneToMany(() => Role, (role) => role.app)
  roles!: Role[];

  @OneToMany(() => Permission, (permission) => permission.app)
  permissions!: Permission[];
}

// ============================================
// 4. USER_APPS (Multi-Tenant Memberships)
// ============================================

@Entity('user_apps')
@Index(['user_id', 'app_id'], { unique: true })
export class UserApp {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  user_id!: string;

  @Column('uuid')
  app_id!: string;

  @CreateDateColumn()
  created_at!: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.app_memberships, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => App, (app) => app.user_memberships, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'app_id' })
  app!: App;

  @ManyToMany(() => Role)
  @JoinTable({
    name: 'user_app_roles',
    joinColumn: { name: 'user_app_id' },
    inverseJoinColumn: { name: 'role_id' },
  })
  roles!: Role[];
}

// ============================================
// 5. ROLES (App-Scoped Roles)
// ============================================

@Entity('roles')
@Index(['app_id', 'name'], { unique: true })
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  app_id!: string;

  @Column('varchar')
  name!: string;

  @Column('varchar', { nullable: true })
  description?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relations
  @ManyToOne(() => App, (app) => app.roles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'app_id' })
  app!: App;

  @ManyToMany(() => Permission)
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id' },
    inverseJoinColumn: { name: 'permission_id' },
  })
  permissions!: Permission[];
}

// ============================================
// 6. PERMISSIONS (Fine-Grained Access Control)
// ============================================

@Entity('permissions')
@Index(['app_id', 'name'], { unique: true })
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  app_id!: string;

  @Column('varchar')
  name!: string; // e.g., "create:order", "read:user", "delete:data"

  @Column('varchar', { nullable: true })
  resource?: string; // e.g., "order", "user", "data"

  @Column('varchar', { nullable: true })
  action?: string; // e.g., "create", "read", "update", "delete"

  @Column('varchar', { nullable: true })
  description?: string;

  @CreateDateColumn()
  created_at!: Date;

  // Relations
  @ManyToOne(() => App, (app) => app.permissions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'app_id' })
  app!: App;
}

// ============================================
// 7. SESSIONS (Refresh Tokens & Device Tracking)
// ============================================

@Entity('sessions')
@Index(['user_id', 'app_id'])
@Index(['device_id'])
@Index(['expires_at'])
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  user_id!: string;

  @Column('uuid')
  app_id!: string;

  @Column('varchar')
  device_id!: string; // Unique device identifier

  @Column('varchar', { nullable: true })
  device_name?: string; // e.g., "iPhone 14 Pro"

  @Column('varchar', { nullable: true })
  device_type?: string; // e.g., "mobile", "web", "desktop"

  @Column('varchar')
  user_agent!: string;

  @Column('inet')
  ip_address!: string;

  // Refresh token (hashed)
  @Column('varchar')
  refresh_token_hash!: string;

  @Column('boolean', { default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @Column('timestamp')
  last_active_at!: Date;

  @Column('timestamp')
  expires_at!: Date;

  @Column('jsonb', { default: {} })
  metadata!: {
    location?: { lat: number; lng: number; country?: string; city?: string };
    fingerprint?: string;
  };

  // Relations
  @ManyToOne(() => User, (user) => user.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}

// ============================================
// 8. VERIFICATION_TOKENS (Email & SMS Verification)
// ============================================

@Entity('verification_tokens')
@Index(['token'])
@Index(['expires_at'])
export class VerificationToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { nullable: true })
  user_id?: string;

  @Column('varchar')
  type!: 'email_verification' | 'sms_verification' | 'password_reset';

  @Column('varchar')
  token!: string; // JWT or random token

  @Column('varchar', { nullable: true })
  email?: string;

  @Column('varchar', { nullable: true })
  phone?: string;

  @Column('integer', { default: 0 })
  attempt_count!: number;

  @Column('integer', { default: 3 })
  max_attempts!: number;

  @CreateDateColumn()
  created_at!: Date;

  @Column('timestamp')
  expires_at!: Date;

  @Column('boolean', { default: false })
  is_used!: boolean;
}

// ============================================
// 9. AUDIT_LOGS (Observability & Compliance)
// ============================================

@Entity('audit_logs')
@Index(['user_id', 'app_id'])
@Index(['event_type'])
@Index(['timestamp'])
@Index(['ip_address'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { nullable: true })
  user_id?: string;

  @Column('uuid', { nullable: true })
  app_id?: string;

  @Column('varchar')
  event_type!:
    | 'login'
    | 'login_failed'
    | 'logout'
    | 'register'
    | 'identity_linked'
    | 'session_revoked'
    | 'password_changed'
    | 'account_suspended'
    | 'account_deleted';

  @Column('varchar', { nullable: true })
  provider?: string; // 'email', 'sms', 'google', 'apple', etc.

  @Column('varchar')
  status!: 'success' | 'failed';

  @Column('varchar', { nullable: true })
  failure_reason?: string; // 'invalid_password', 'account_locked', etc.

  @Column('inet')
  ip_address!: string;

  @Column('varchar', { nullable: true })
  user_agent?: string;

  @Column('varchar', { nullable: true })
  device_id?: string;

  @Column('jsonb', { default: {} })
  metadata!: Record<string, any>;

  @CreateDateColumn()
  timestamp!: Date;
}

// ============================================
// 10. FAILED_ATTEMPTS (Brute-Force Protection)
// ============================================

@Entity('failed_attempts')
@Index(['identity_id'])
@Index(['ip_address'])
@Index(['locked_until'])
export class FailedAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { nullable: true })
  identity_id?: string; // Links to email/phone identity

  @Column('inet')
  ip_address!: string;

  @Column('integer', { default: 1 })
  attempt_count!: number;

  @Column('integer', { default: 5 })
  max_attempts!: number;

  @CreateDateColumn()
  first_attempt_at!: Date;

  @Column('timestamp', { nullable: true })
  locked_until?: Date; // When brute-force lockout expires

  @Column('varchar', { default: 'login_attempt' })
  attempt_type!: string; // 'login_attempt', 'otp_verification', etc.
}

// ============================================
// 11. OTP_CODES (SMS/Email OTP Storage)
// ============================================

@Entity('otp_codes')
@Index(['phone_number'])
@Index(['email'])
@Index(['expires_at'])
export class OtpCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { nullable: true })
  phone_number?: string;

  @Column('varchar', { nullable: true })
  email?: string;

  @Column('varchar')
  code!: string; // 6-digit OTP

  @Column('varchar')
  method!: 'sms' | 'email';

  @Column('integer', { default: 0 })
  attempt_count!: number;

  @Column('integer', { default: 3 })
  max_attempts!: number;

  @CreateDateColumn()
  created_at!: Date;

  @Column('timestamp')
  expires_at!: Date;

  @Column('boolean', { default: false })
  is_verified!: boolean;
}

// ============================================
// 12. REFRESH_TOKEN_REVOCATIONS (Token Rotation & Revocation)
// ============================================

@Entity('refresh_token_revocations')
@Index(['user_id'])
@Index(['revoked_at'])
export class RefreshTokenRevocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  user_id!: string;

  @Column('varchar')
  token_jti!: string; // JWT ID of the refresh token

  @CreateDateColumn()
  revoked_at!: Date;

  @Column('timestamp')
  expires_at!: Date; // When this record can be deleted
}

// ============================================
// Database Schema Notes:
// ============================================
/*

INDEXES:
- Unique indexes on email, oauth provider_id prevent duplicates
- Composite indexes on (user_id, app_id) for efficient filtering
- Indexes on timestamps for retention queries
- Index on is_active for session queries

CONSTRAINTS:
- Foreign keys ensure referential integrity
- ON DELETE CASCADE maintains consistency
- Unique constraints prevent duplication

REASONING:
- Identities table allows multiple login methods per user
- Sessions table supports multi-device support
- Separate audit_logs for compliance
- OTP codes in separate table for quick lookup and cleanup
- Refresh token revocations prevent old token reuse

SCALING CONSIDERATIONS:
- Audit logs can be partitioned by date
- Sessions can be archived (move to cold storage after 90 days)
- OTP codes auto-cleanup via TTL index or scheduled job
- Refresh token revocations can be cleared after token expiry

*/
