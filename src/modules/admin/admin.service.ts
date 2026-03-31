import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { User, App, Session, AuditLog } from '../../database/entities';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private usersRepo: Repository<User>,

    @InjectRepository(App)
    private appsRepo: Repository<App>,

    @InjectRepository(Session)
    private sessionsRepo: Repository<Session>,

    @InjectRepository(AuditLog)
    private auditLogsRepo: Repository<AuditLog>,
  ) {}

  listUsers() {
    return this.usersRepo.find({ order: { created_at: 'DESC' } });
  }

  getUser(id: string) {
    return this.usersRepo.findOneOrFail({ where: { id } });
  }

  getUserSessions(userId: string) {
    return this.sessionsRepo.find({
      where: { user_id: userId, is_active: true },
      order: { last_active_at: 'DESC' },
    });
  }

  getUserAuditLogs(userId: string) {
    return this.auditLogsRepo.find({
      where: { user_id: userId },
      order: { timestamp: 'DESC' },
      take: 100,
    });
  }

  async disableUser(id: string) {
    const user = await this.usersRepo.findOneOrFail({ where: { id } });
    user.status = user.status === 'suspended' ? 'active' : 'suspended';
    return this.usersRepo.save(user);
  }

  async deleteUser(id: string) {
    const user = await this.usersRepo.findOneOrFail({ where: { id } });
    user.status = 'deleted';
    user.deleted_at = new Date();
    await this.usersRepo.save(user);
    await this.sessionsRepo.update({ user_id: id }, { is_active: false });
  }

  listApps() {
    return this.appsRepo.find({ order: { created_at: 'DESC' } });
  }

  async createApp(data: { name: string; description?: string; ownerId: string }) {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const app = this.appsRepo.create({
      name: data.name,
      description: data.description,
      owner_id: data.ownerId,
      slug,
      status: 'active',
      config: {},
    });
    return this.appsRepo.save(app);
  }

  async deleteApp(id: string) {
    await this.appsRepo.delete(id);
  }

  listSessions() {
    return this.sessionsRepo.find({
      where: { is_active: true },
      order: { last_active_at: 'DESC' },
      take: 500,
    });
  }

  async revokeSession(id: string) {
    await this.sessionsRepo.update(id, { is_active: false });
  }

  listAuditLogs(limit = 100, offset = 0) {
    return this.auditLogsRepo.find({
      order: { timestamp: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async getOverviewStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      activeSessionsCount,
      newUsersToday,
      loginEventsToday,
      failedLoginsToday,
    ] = await Promise.all([
      this.usersRepo.count({ where: { status: 'active' } }),
      this.sessionsRepo.count({ where: { is_active: true } }),
      this.usersRepo.count({ where: { created_at: MoreThan(today) } }),
      this.auditLogsRepo.count({ where: { event_type: 'login', status: 'success', timestamp: MoreThan(today) } }),
      this.auditLogsRepo.count({ where: { event_type: 'login_failed', status: 'failed', timestamp: MoreThan(today) } }),
    ]);

    const since = new Date();
    since.setDate(since.getDate() - 14);

    const recentLogins = await this.auditLogsRepo
      .createQueryBuilder('log')
      .select("DATE(log.timestamp)", 'date')
      .addSelect('COUNT(*)', 'count')
      .where('log.event_type = :type', { type: 'login' })
      .andWhere('log.status = :status', { status: 'success' })
      .andWhere('log.timestamp >= :since', { since })
      .groupBy('DATE(log.timestamp)')
      .orderBy('date', 'ASC')
      .getRawMany();

    return {
      totalUsers,
      activeSessionsCount,
      newUsersToday,
      loginEventsToday,
      failedLoginsToday,
      loginsByDay: recentLogins.map((r) => ({ date: r.date, count: Number(r.count) })),
    };
  }
}
