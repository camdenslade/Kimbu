import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { CacheModule } from '@nestjs/cache-manager';
import * as ioredis from 'ioredis';

import { TokenService } from './common/token.service';
import { SecurityService } from './common/security.service';
import { AuthModule } from './modules/auth/auth.module';

import {
  User,
  Identity,
  App,
  UserApp,
  Role,
  Permission,
  Session,
  VerificationToken,
  AuditLog,
  FailedAttempt,
  OtpCode,
  RefreshTokenRevocation,
} from './database/entities';

/**
 * MAIN APPLICATION MODULE
 *
 * Initializes:
 * - Database (PostgreSQL)
 * - Cache (Redis)
 * - JWT configuration
 * - Services
 * - Providers
 */

@Module({
  imports: [
    // Environment configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get('DB_PORT', 5432),
        username: configService.get('DB_USERNAME', 'postgres'),
        password: configService.get('DB_PASSWORD', 'postgres'),
        database: configService.get('DB_NAME', 'auth_db'),
        entities: [
          User,
          Identity,
          App,
          UserApp,
          Role,
          Permission,
          Session,
          VerificationToken,
          AuditLog,
          FailedAttempt,
          OtpCode,
          RefreshTokenRevocation,
        ],
        synchronize: configService.get('NODE_ENV') === 'development',
        logging: configService.get('NODE_ENV') === 'development',
        ssl: configService.get('DB_SSL') === 'true' ? { rejectUnauthorized: false } : false,
      }),
    }),

    // Entity repositories
    TypeOrmModule.forFeature([
      User,
      Identity,
      App,
      UserApp,
      Role,
      Permission,
      Session,
      VerificationToken,
      AuditLog,
      FailedAttempt,
      OtpCode,
      RefreshTokenRevocation,
    ]),

    // Redis cache
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redis = new ioredis.Redis({
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 6379),
          password: configService.get('REDIS_PASSWORD'),
          db: configService.get('REDIS_DB', 0),
        });

        return {
          store: {
            getConnection: () => redis,
          } as any,
        };
      },
    }),

    // JWT
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'your-secret-key-change-in-prod'),
        signOptions: { expiresIn: '15m' },
      }),
    }),

    // Auth module
    AuthModule,
  ],
  providers: [TokenService, SecurityService],
  exports: [TokenService, SecurityService, TypeOrmModule, ConfigModule, CacheModule, AuthModule],
})
export class AppModule {}
