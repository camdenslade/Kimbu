import {
  Controller,
  Get,
  Post,
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
}
