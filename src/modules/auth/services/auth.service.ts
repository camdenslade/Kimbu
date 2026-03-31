import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { TokenService } from '../../../common/token.service';
import { SecurityService } from '../../../common/security.service';
import {
  User,
  Identity,
  Session,
  AuditLog,
  App,
  UserApp,
} from '../../../database/entities';

/**
 * AUTH SERVICE
 *
 * Core orchestration for authentication flows
 * - Handles login/register/logout
 * - Session management
 * - Token generation and refresh
 * - Audit logging
 * - Multi-tenant coordination
 */

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device_id: string;
  user: {
    id: string;
    email?: string;
    phone?: string;
    name?: string;
    roles: string[];
  };
}

interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,

    @InjectRepository(Identity)
    private identitiesRepository: Repository<Identity>,

    @InjectRepository(Session)
    private sessionsRepository: Repository<Session>,

    @InjectRepository(AuditLog)
    private auditLogsRepository: Repository<AuditLog>,

    @InjectRepository(UserApp)
    private userAppsRepository: Repository<UserApp>,

    @InjectRepository(App)
    private appsRepository: Repository<App>,

    private tokenService: TokenService,
    private securityService: SecurityService
  ) {}

  // ============================================
  // REGISTRATION
  // ============================================

  /**
   * Register a new user with email + password, create identity and session
   */
  async register(
    email: string,
    password: string,
    name: string | undefined,
    appId: string,
    ipAddress: string,
    userAgent: string,
    deviceId: string,
  ): Promise<LoginResponse & { isNewUser: boolean }> {
    const normalizedEmail = email.toLowerCase().trim();

    // Check email taken
    const existing = await this.identitiesRepository.findOne({
      where: { email: normalizedEmail, identity_type: 'email' as const },
    });
    if (existing) {
      throw new Error('Email already registered');
    }

    // Hash password
    const passwordHash = await this.securityService.hashPassword(password);

    // Create user
    const user = this.usersRepository.create({
      email: normalizedEmail,
      name,
      email_verified: false,
      phone_verified: false,
      status: 'active',
    });
    const savedUser = await this.usersRepository.save(user);

    // Create identity
    const identity = this.identitiesRepository.create({
      user_id: savedUser.id,
      identity_type: 'email' as const,
      email: normalizedEmail,
      password_hash: passwordHash,
      is_primary: true,
      is_verified: false,
    });
    await this.identitiesRepository.save(identity);

    // Create session + tokens
    const session = await this.createSession(savedUser.id, appId, ipAddress, userAgent, deviceId, 'email');

    return { ...session, isNewUser: true };
  }

  // ============================================
  // LOGIN / SESSION CREATION
  // ============================================

  /**
   * Create new session after successful authentication
   *
   * steps:
   * 1. Generate JWT (15 min expiry)
   * 2. Generate refresh token (7 day expiry)
   * 3. Create session record (tracks device, IP, user agent)
   * 4. Log auth event
   */
  async createSession(
    userId: string,
    appId: string,
    ipAddress: string,
    userAgent: string,
    deviceId: string,
    provider: string
  ): Promise<LoginResponse> {
    // Get user + roles
    const user = await this.usersRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new Error('User not found');
    }

    // Get user's roles in this app
    const userApp = await this.userAppsRepository.findOne({
      where: { user_id: userId, app_id: appId },
      relations: ['roles'],
    });

    const roles = userApp?.roles.map((r) => r.name) || [];

    // Generate tokens
    const tokenPair = this.tokenService.generateTokenPair(
      userId,
      appId,
      roles,
      deviceId
    );

    // Create session record
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 day session

    const session = this.sessionsRepository.create({
      user_id: userId,
      app_id: appId,
      device_id: deviceId,
      user_agent: userAgent,
      ip_address: ipAddress,
      refresh_token_hash: tokenPair.refresh_token_hash,
      is_active: true,
      expires_at: expiresAt,
      last_active_at: new Date(),
    });

    await this.sessionsRepository.save(session);

    // Log auth event
    await this.logAuthEvent({
      user_id: userId,
      app_id: appId,
      event_type: 'login',
      provider,
      status: 'success',
      ip_address: ipAddress,
      user_agent: userAgent,
      device_id: deviceId,
    });

    return {
      access_token: tokenPair.access_token,
      refresh_token: tokenPair.refresh_token,
      expires_in: tokenPair.expires_in,
      device_id: deviceId,
      user: {
        id: userId,
        email: user.email,
        phone: user.phone,
        name: user.name,
        roles,
      },
    };
  }

  // ============================================
  // TOKEN REFRESH
  // ============================================

  /**
   * Refresh access token with refresh token
   *
   * Security features:
   * 1. Verify refresh token against database hash
   * 2. Check token not expired/revoked
   * 3. Issue NEW refresh token (rotation)
   * 4. Invalidate old token
   */
  async refreshAccessToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<RefreshTokenResponse> {
    // Find session by refresh token hash
    const tokenHash = this.tokenService.hashRefreshToken(refreshToken);
    const session = await this.sessionsRepository.findOne({
      where: {
        refresh_token_hash: tokenHash,
        is_active: true,
      },
      relations: ['user'],
    });

    if (!session) {
      // Log suspicious activity
      await this.auditLogsRepository.save(
        this.auditLogsRepository.create({
          event_type: 'login_failed' as AuditLog['event_type'],
          status: 'failed',
          failure_reason: 'invalid_refresh_token',
          ip_address: ipAddress ?? '',
          user_agent: userAgent,
        })
      );

      throw new Error('Invalid or expired refresh token');
    }

    // Check session expiration
    if (new Date() > session.expires_at) {
      throw new Error('Session expired');
    }

    // Get user roles
    const userApp = await this.userAppsRepository.findOne({
      where: { user_id: session.user_id, app_id: session.app_id },
      relations: ['roles'],
    });

    const roles = userApp?.roles.map((r) => r.name) || [];

    // Generate new token pair (rotation)
    const newTokenPair = this.tokenService.generateTokenPair(
      session.user_id,
      session.app_id,
      roles,
      session.device_id
    );

    // Update session with new refresh token
    session.refresh_token_hash = newTokenPair.refresh_token_hash;
    session.last_active_at = new Date();
    session.ip_address = ipAddress ?? session.ip_address;
    session.user_agent = userAgent ?? session.user_agent;
    await this.sessionsRepository.save(session);

    return {
      access_token: newTokenPair.access_token,
      refresh_token: newTokenPair.refresh_token,
      expires_in: newTokenPair.expires_in,
    };
  }

  // ============================================
  // LOGOUT
  // ============================================

  /**
   * Logout single session
   */
  async logoutSession(deviceId: string, userId: string): Promise<void> {
    const session = await this.sessionsRepository.findOne({
      where: { device_id: deviceId, user_id: userId },
    });

    if (session) {
      session.is_active = false;
      await this.sessionsRepository.save(session);

      await this.logAuthEvent({
        user_id: userId,
        event_type: 'logout',
        status: 'success',
        ip_address: session.ip_address,
        device_id: deviceId,
      });
    }
  }

  /**
   * Logout all sessions (global logout)
   */
  async logoutAllSessions(userId: string, appId: string): Promise<void> {
    const sessions = await this.sessionsRepository.find({
      where: { user_id: userId, app_id: appId, is_active: true },
    });

    for (const session of sessions) {
      session.is_active = false;
      await this.sessionsRepository.save(session);
    }

    await this.logAuthEvent({
      user_id: userId,
      app_id: appId,
      event_type: 'logout',
      status: 'success',
    });
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

  /**
   * Get active sessions for user
   */
  async getUserSessions(userId: string, appId: string) {
    return this.sessionsRepository.find({
      where: {
        user_id: userId,
        app_id: appId,
        is_active: true,
      },
      order: { last_active_at: 'DESC' },
    });
  }

  /**
   * Revoke specific session
   */
  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.sessionsRepository.findOne({
      where: { id: sessionId, user_id: userId },
    });

    if (session) {
      session.is_active = false;
      await this.sessionsRepository.save(session);
    }
  }

  // ============================================
  // AUDIT LOGGING
  // ============================================

  /**
   * Log authentication events
   * Used for compliance, security monitoring, analytics
   */
  async logAuthEvent(event: {
    user_id?: string;
    app_id?: string;
    event_type: string;
    provider?: string;
    status: 'success' | 'failed';
    failure_reason?: string;
    ip_address?: string;
    user_agent?: string;
    device_id?: string;
  }): Promise<void> {
    const auditLog = this.auditLogsRepository.create({
      ...event,
      event_type: event.event_type as AuditLog['event_type'],
    });

    await this.auditLogsRepository.save(auditLog);
  }

  /**
   * Get audit logs for user
   */
  async getUserAuditLogs(userId: string, appId?: string, days: number = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    return this.auditLogsRepository.find({
      where: {
        user_id: userId,
        ...(appId ? { app_id: appId } : {}),
      },
      order: { timestamp: 'DESC' },
    });
  }

  // ============================================
  // IDENTITY LINKING
  // ============================================

  /**
   * Link new identity to existing user
   * Allows one user to have multiple login methods
   */
  async linkIdentity(
    userId: string,
    identityType: string,
    identityValue: string
  ): Promise<Identity> {
    // Check if identity already linked
    const existing = await this.identitiesRepository.findOne({
      where: {
        user_id: userId,
        identity_type: identityType as Identity['identity_type'],
      },
    });

    if (existing) {
      throw new Error(`${identityType} already linked to this account`);
    }

    // Create new identity
    const identity = this.identitiesRepository.create({
      user_id: userId,
      identity_type: identityType as Identity['identity_type'],
      ...(identityType === 'email' && { email: identityValue }),
      ...(identityType === 'phone' && { phone: identityValue }),
      ...(identityType !== 'email' && identityType !== 'phone' && {
        provider_id: identityValue,
      }),
      is_verified: false,
    });

    const saved = await this.identitiesRepository.save(identity);

    // Log identity linking
    await this.logAuthEvent({
      user_id: userId,
      event_type: 'identity_linked',
      status: 'success',
    });

    return saved;
  }

  /**
   * Unlink identity from user
   * Must have at least 1 identity remaining
   */
  async unlinkIdentity(userId: string, identityId: string): Promise<void> {
    const identity = await this.identitiesRepository.findOne({
      where: { id: identityId, user_id: userId },
    });

    if (!identity) {
      throw new Error('Identity not found');
    }

    // Check if user has other identities
    const identityCount = await this.identitiesRepository.count({
      where: { user_id: userId },
    });

    if (identityCount <= 1) {
      throw new Error('Cannot unlink last identity');
    }

    await this.identitiesRepository.remove(identity);
  }

  /**
   * Get user's linked identities
   */
  async getUserIdentities(userId: string): Promise<Identity[]> {
    return this.identitiesRepository.find({
      where: { user_id: userId },
    });
  }

  // ============================================
  // USER PROFILE
  // ============================================

  /**
   * Get current user profile
   */
  async getUserProfile(userId: string, appId?: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    let roles: string[] = [];
    if (appId) {
      const userApp = await this.userAppsRepository.findOne({
        where: { user_id: userId, app_id: appId },
        relations: ['roles'],
      });
      roles = userApp?.roles.map((r) => r.name) || [];
    }

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      avatar_url: user.avatar_url,
      email_verified: user.email_verified,
      phone_verified: user.phone_verified,
      roles,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  /**
   * Update user profile
   */
  async updateUserProfile(
    userId: string,
    updates: { name?: string; avatar_url?: string }
  ): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new Error('User not found');
    }

    if (updates.name) user.name = updates.name;
    if (updates.avatar_url) user.avatar_url = updates.avatar_url;

    return this.usersRepository.save(user);
  }
}
