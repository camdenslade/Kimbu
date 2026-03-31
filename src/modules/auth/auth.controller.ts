import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { v4 as uuidv4 } from 'uuid';

import { AuthService } from './services/auth.service';
import { TokenService } from '../../common/token.service';
import { SecurityService } from '../../common/security.service';
import { ProvidersRegistry, AuthMethod } from './providers/interfaces';
import { EmailPasswordProvider } from './providers/email-password.provider';
import { SmsOtpProvider } from './providers/sms-otp.provider';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtAuthService, JwtPayload } from '../../common/jwt-auth.service';
import { RateLimitService, loginRateLimitConfig, otpRateLimitConfig, refreshTokenRateLimitConfig } from '../../common/middleware/rate-limit.middleware';

import {
  RegisterDto,
  LoginDto,
  RequestOtpDto,
  VerifyOtpDto,
  RefreshTokenDto,
  LogoutDto,
  UpdateProfileDto,
  LinkIdentityDto,
  UnlinkIdentityDto,
  ChangePasswordDto,
  OAuthLoginDto,
} from './dto/auth.dto';

import {
  AuthResponse,
  TokenResponse,
  UserResponse,
  SessionResponse,
  AuditLogResponse,
  MessageResponse,
  ErrorResponse,
} from './dto/response.dto';

@Controller('v1/auth')
export class AuthController {
  private providersRegistry: ProvidersRegistry;

  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly securityService: SecurityService,
    private readonly jwtAuthService: JwtAuthService,
    private readonly rateLimitService: RateLimitService,
    private readonly emailPasswordProvider: EmailPasswordProvider,
    private readonly smsOtpProvider: SmsOtpProvider,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    // Initialize provider registry
    this.providersRegistry = new ProvidersRegistry();
    this.providersRegistry.register(AuthMethod.EMAIL_PASSWORD, this.emailPasswordProvider);
    this.providersRegistry.register(AuthMethod.SMS_OTP, this.smsOtpProvider);
  }

  /**
   * POST /v1/auth/register
   * Register a new user with email and password
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() registerDto: RegisterDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || '';
      const userAgent = req.headers['user-agent'] || '';
      const deviceId = uuidv4();
      const appId = req.headers['x-app-id'] as string || 'default';

      // Check rate limit
      const key = this.rateLimitService.createKeyGenerator('register')(req);
      const limitCheck = await this.rateLimitService.checkLimit(key, {
        windowMs: 60 * 60 * 1000, // 1 hour
        maxRequests: 10,
      });

      if (!limitCheck.allowed) {
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many registration attempts. Please try again later.',
          timestamp: new Date(),
        } as ErrorResponse);
        return;
      }

      const result = await this.authService.register(
        registerDto.email,
        registerDto.password,
        registerDto.name,
        appId,
        ipAddress,
        userAgent,
        deviceId,
      );

      res.status(HttpStatus.CREATED).json({
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          emailVerified: false,
          phoneVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as UserResponse,
        tokens: {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresIn: result.expires_in,
        } as TokenResponse,
        isNewUser: true,
      } as AuthResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'REGISTRATION_FAILED',
        message: (error as Error).message || 'Registration failed',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/login
   * Login with email and password
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || '';
      const userAgent = req.headers['user-agent'] || '';
      const deviceId = uuidv4();
      const appId = req.headers['x-app-id'] as string || 'default';

      // Check rate limit
      const limitKey = `login:${loginDto.email}`;
      const limitCheck = await this.rateLimitService.checkLimit(limitKey, loginRateLimitConfig);

      if (!limitCheck.allowed) {
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many login attempts. Please try again later.',
          timestamp: new Date(),
        } as ErrorResponse);
        return;
      }

      // Authenticate using email/password provider
      const authResult = await this.emailPasswordProvider.authenticate({
        email: loginDto.email,
        password: loginDto.password,
        app_id: appId,
        ip_address: ipAddress,
        user_agent: userAgent,
        device_id: deviceId,
      });

      const session = await this.authService.createSession(
        authResult.user_id,
        appId,
        ipAddress,
        userAgent,
        deviceId,
        'email',
      );

      res.json({
        user: {
          id: session.user.id,
          email: session.user.email,
          emailVerified: true,
          phoneVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as UserResponse,
        tokens: {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresIn: session.expires_in,
        } as TokenResponse,
        isNewUser: false,
      } as AuthResponse);
    } catch (error) {
      // Log failed attempt
      const appId = req.headers['x-app-id'] as string || 'default';
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || '';
      await this.authService.logAuthEvent({
        event_type: 'login_failed',
        status: 'failed',
        provider: 'email',
        failure_reason: (error as Error).message,
        ip_address: ipAddress,
        app_id: appId,
      });

      res.status(HttpStatus.UNAUTHORIZED).json({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/login/sms
   * Request SMS OTP for login
   */
  @Post('login/sms')
  @HttpCode(HttpStatus.OK)
  async requestOtp(
    @Body() requestOtpDto: RequestOtpDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const appId = req.headers['x-app-id'] as string || 'default';

      // Check rate limit
      const limitKey = `otp:${requestOtpDto.phoneNumber}`;
      const limitCheck = await this.rateLimitService.checkLimit(limitKey, otpRateLimitConfig);

      if (!limitCheck.allowed) {
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many OTP requests. Please try again later.',
          timestamp: new Date(),
        } as ErrorResponse);
        return;
      }

      // Request OTP from SMS provider
      const result = await this.smsOtpProvider.requestOtp(requestOtpDto.phoneNumber, appId);

      res.json({
        message: 'OTP sent to your phone',
        otpRequestId: result.otp_request_id,
        expiresIn: 300, // 5 minutes
      });
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'OTP_REQUEST_FAILED',
        message: (error as Error).message || 'Failed to send OTP',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/verify-sms
   * Verify SMS OTP and login
   */
  @Post('verify-sms')
  @HttpCode(HttpStatus.OK)
  async verifySmsOtp(
    @Body() verifyOtpDto: VerifyOtpDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || '';
      const userAgent = req.headers['user-agent'] || '';
      const deviceId = uuidv4();
      const appId = req.headers['x-app-id'] as string || 'default';

      // Verify OTP using SMS provider
      const authResult = await this.smsOtpProvider.authenticate({
        phone_number: verifyOtpDto.phoneNumber,
        otp: verifyOtpDto.otp,
        app_id: appId,
        ip_address: ipAddress,
        user_agent: userAgent,
        device_id: deviceId,
      });

      const session = await this.authService.createSession(
        authResult.user_id,
        appId,
        ipAddress,
        userAgent,
        deviceId,
        'sms',
      );

      res.json({
        user: {
          id: session.user.id,
          phone: authResult.phone,
          phoneVerified: true,
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as UserResponse,
        tokens: {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresIn: session.expires_in,
        } as TokenResponse,
        isNewUser: authResult.is_new_user,
      } as AuthResponse);
    } catch (error) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        code: 'INVALID_OTP',
        message: (error as Error).message || 'Invalid or expired OTP',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/login/oauth
   * OAuth provider login (Google, Apple, GitHub)
   */
  @Post('login/oauth')
  @HttpCode(HttpStatus.OK)
  async oauthLogin(
    @Body() oauthLoginDto: OAuthLoginDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      // OAuth implementation would go here
      // For now, return not implemented
      res.status(HttpStatus.NOT_IMPLEMENTED).json({
        code: 'OAUTH_NOT_IMPLEMENTED',
        message: 'OAuth providers not yet implemented',
        timestamp: new Date(),
      } as ErrorResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'OAUTH_LOGIN_FAILED',
        message: (error as Error).message || 'OAuth login failed',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/refresh
   * Refresh access token with refresh token
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      // Check rate limit
      const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || '';
      const limitKey = `refresh:${ipAddress}`;
      const limitCheck = await this.rateLimitService.checkLimit(limitKey, refreshTokenRateLimitConfig);

      if (!limitCheck.allowed) {
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many token refresh attempts',
          timestamp: new Date(),
        } as ErrorResponse);
        return;
      }

      // Refresh token (rotation pattern)
      const result = await this.authService.refreshAccessToken(
        refreshTokenDto.refreshToken,
        ipAddress,
        req.headers['user-agent'] || '',
      );

      res.json({
        tokens: {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresIn: result.expires_in,
        } as TokenResponse,
      });
    } catch (error) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid or expired refresh token',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/logout
   * Logout current session or all sessions
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() logoutDto: LogoutDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;

      if (logoutDto.deviceId) {
        // Logout specific device
        await this.authService.logoutSession(logoutDto.deviceId, user.sub);
      } else {
        // Logout all devices
        await this.authService.logoutAllSessions(user.sub, user.app_id);
      }

      res.json({ message: 'Logged out successfully' } as MessageResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'LOGOUT_FAILED',
        message: (error as Error).message || 'Logout failed',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * GET /v1/auth/me
   * Get current user profile
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const userProfile = await this.authService.getUserProfile(user.sub, user.app_id);

      res.json({
        id: userProfile.id,
        email: userProfile.email,
        phone: userProfile.phone,
        name: userProfile.name,
        emailVerified: userProfile.email_verified,
        phoneVerified: userProfile.phone_verified,
        createdAt: userProfile.created_at,
        updatedAt: userProfile.updated_at,
      } as UserResponse);
    } catch (error) {
      res.status(HttpStatus.NOT_FOUND).json({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * PATCH /v1/auth/me
   * Update user profile
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async updateProfile(
    @Body() updateProfileDto: UpdateProfileDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const updated = await this.authService.updateUserProfile(user.sub, {
        name: updateProfileDto.name,
        avatar_url: updateProfileDto.avatar,
      });

      res.json({
        id: updated.id,
        email: updated.email,
        phone: updated.phone,
        name: updated.name,
        avatar: updated.avatar_url,
        emailVerified: updated.email_verified,
        phoneVerified: updated.phone_verified,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      } as UserResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'PROFILE_UPDATE_FAILED',
        message: (error as Error).message || 'Failed to update profile',
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * GET /v1/auth/me/identities
   * List linked identities
   */
  @Get('me/identities')
  @UseGuards(JwtAuthGuard)
  async getIdentities(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const identities = await this.authService.getUserIdentities(user.sub);

      res.json(identities);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_GET_IDENTITIES',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/me/identities/link
   * Link a new identity to user account
   */
  @Post('me/identities/link')
  @UseGuards(JwtAuthGuard)
  async linkIdentity(
    @Body() linkIdentityDto: LinkIdentityDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const linked = await this.authService.linkIdentity(
        user.sub,
        linkIdentityDto.method,
        linkIdentityDto.value ?? '',
      );

      res.json(linked);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_LINK_IDENTITY',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/me/identities/:id/unlink
   * Unlink an identity from user account
   */
  @Delete('me/identities/:id')
  @UseGuards(JwtAuthGuard)
  async unlinkIdentity(
    @Body() unlinkIdentityDto: UnlinkIdentityDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      await this.authService.unlinkIdentity(user.sub, unlinkIdentityDto.identityId);

      res.json({ message: 'Identity unlinked successfully' } as MessageResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_UNLINK_IDENTITY',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * POST /v1/auth/me/change-password
   * Change user password
   */
  @Post('me/change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Body() changePasswordDto: ChangePasswordDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      await this.emailPasswordProvider.changePassword(user.sub, changePasswordDto.oldPassword, changePasswordDto.newPassword);

      res.json({ message: 'Password changed successfully' } as MessageResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'PASSWORD_CHANGE_FAILED',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * GET /v1/auth/me/sessions
   * List active sessions
   */
  @Get('me/sessions')
  @UseGuards(JwtAuthGuard)
  async getUserSessions(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const sessions = await this.authService.getUserSessions(user.sub, user.app_id);

      res.json(sessions);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_GET_SESSIONS',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * DELETE /v1/auth/me/sessions/:deviceId
   * Revoke specific session
   */
  @Delete('me/sessions/:deviceId')
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const { deviceId } = req.params;
      await this.authService.logoutSession(deviceId, user.sub);

      res.json({ message: 'Session revoked' } as MessageResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_REVOKE_SESSION',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * DELETE /v1/auth/me/sessions
   * Revoke all sessions (global logout)
   */
  @Delete('me/sessions')
  @UseGuards(JwtAuthGuard)
  async revokeAllSessions(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      await this.authService.logoutAllSessions(user.sub, user.app_id);

      res.json({ message: 'All sessions revoked' } as MessageResponse);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_REVOKE_SESSIONS',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }

  /**
   * GET /v1/auth/me/audit-logs
   * Get user audit logs
   */
  @Get('me/audit-logs')
  @UseGuards(JwtAuthGuard)
  async getAuditLogs(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const user = req.user!;
      const logs = await this.authService.getUserAuditLogs(user.sub, user.app_id);

      res.json(logs);
    } catch (error) {
      res.status(HttpStatus.BAD_REQUEST).json({
        code: 'FAILED_TO_GET_AUDIT_LOGS',
        message: (error as Error).message,
        timestamp: new Date(),
      } as ErrorResponse);
    }
  }
}
