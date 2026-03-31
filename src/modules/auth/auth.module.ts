import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';

import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { EmailPasswordProvider } from './providers/email-password.provider';
import { SmsOtpProvider } from './providers/sms-otp.provider';

import { User, Identity, App, UserApp, Role, Permission, Session, VerificationToken, OtpCode, AuditLog, FailedAttempt, RefreshTokenRevocation } from '../../database/entities';
import { SecurityService } from '../../common/security.service';
import { TokenService } from '../../common/token.service';
import { JwtAuthService } from '../../common/jwt-auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RateLimitService } from '../../common/middleware/rate-limit.middleware';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Identity, App, UserApp, Role, Permission, Session, VerificationToken, OtpCode, AuditLog, FailedAttempt, RefreshTokenRevocation]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET') || 'your-secret-key',
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRY') || '15m',
          algorithm: 'HS256',
        },
      }),
    }),
    CacheModule.register(),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SecurityService,
    TokenService,
    JwtAuthService,
    JwtAuthGuard,
    RoleGuard,
    PermissionGuard,
    RateLimitService,
    EmailPasswordProvider,
    SmsOtpProvider,
  ],
  exports: [
    AuthService,
    SecurityService,
    TokenService,
    JwtAuthService,
    JwtAuthGuard,
    RoleGuard,
    PermissionGuard,
    RateLimitService,
  ],
})
export class AuthModule {}
