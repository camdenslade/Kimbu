import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User, App, Session, AuditLog, UserApp, Identity, Role } from '../../database/entities';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtAuthService } from '../../common/jwt-auth.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, App, Session, AuditLog, UserApp, Identity, Role])],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, JwtAuthGuard, JwtAuthService],
})
export class AdminModule {}
