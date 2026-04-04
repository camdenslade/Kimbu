import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  getStats() {
    return this.adminService.getOverviewStats();
  }

  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Get('users/:id/sessions')
  getUserSessions(@Param('id') id: string) {
    return this.adminService.getUserSessions(id);
  }

  @Get('users/:id/audit-logs')
  getUserAuditLogs(@Param('id') id: string) {
    return this.adminService.getUserAuditLogs(id);
  }

  @Post('users/:id/disable')
  @HttpCode(HttpStatus.OK)
  disableUser(@Param('id') id: string) {
    return this.adminService.disableUser(id);
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  @Get('apps')
  listApps() {
    return this.adminService.listApps();
  }

  @Post('apps')
  @HttpCode(HttpStatus.CREATED)
  createApp(@Body() body: { name: string; description?: string }, @Req() req: Request) {
    return this.adminService.createApp({ ...body, ownerId: req.user!.sub });
  }

  @Delete('apps/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteApp(@Param('id') id: string) {
    return this.adminService.deleteApp(id);
  }

  @Get('sessions')
  listSessions() {
    return this.adminService.listSessions();
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeSession(@Param('id') id: string) {
    return this.adminService.revokeSession(id);
  }

  @Get('audit-logs')
  listAuditLogs(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.adminService.listAuditLogs(limit, offset);
  }

  // ============================================
  // POOL (APP) DETAIL ROUTES
  // ============================================

  @Get('pools/:id')
  getPool(@Param('id') id: string) {
    return this.adminService.getPool(id);
  }

  @Get('pools/:id/users')
  getPoolUsers(@Param('id') id: string) {
    return this.adminService.getPoolUsers(id);
  }

  @Post('pools/:id/users')
  @HttpCode(HttpStatus.CREATED)
  createPoolUser(
    @Param('id') id: string,
    @Body() body: { email: string; password: string; name?: string },
    @Req() req: Request,
  ) {
    return this.adminService.createPoolUser(id, body, (req as any).user.sub);
  }

  @Patch('pools/:id/config')
  updatePoolConfig(
    @Param('id') id: string,
    @Body() body: {
      mfa_required?: boolean;
      session_duration_hours?: number;
      oauth_redirect_uris?: string[];
      password_min_length?: number;
      password_require_uppercase?: boolean;
      password_require_numbers?: boolean;
      password_require_symbols?: boolean;
    },
  ) {
    return this.adminService.updatePoolConfig(id, body);
  }

  @Post('pools/:id/api-key')
  @HttpCode(HttpStatus.OK)
  regenerateApiKey(@Param('id') id: string) {
    return this.adminService.regeneratePoolApiKey(id);
  }

  @Get('pools/:id/roles')
  getPoolRoles(@Param('id') id: string) {
    return this.adminService.getPoolRoles(id);
  }

  @Post('pools/:id/roles')
  @HttpCode(HttpStatus.CREATED)
  createPoolRole(
    @Param('id') id: string,
    @Body() body: { name: string; description?: string },
  ) {
    return this.adminService.createPoolRole(id, body);
  }

  @Post('pools/:id/users/:userId/roles/:roleName')
  @HttpCode(HttpStatus.OK)
  assignUserRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Param('roleName') roleName: string,
  ) {
    return this.adminService.assignUserRole(id, userId, roleName);
  }

  @Delete('pools/:id/users/:userId/roles/:roleName')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeUserRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Param('roleName') roleName: string,
  ) {
    return this.adminService.removeUserRole(id, userId, roleName);
  }
}
