import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { User, App, Session, AuditLog, UserApp, Identity, Role } from '../../database/entities';
import { randomBytes } from 'crypto';

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

    @InjectRepository(UserApp)
    private userAppsRepo: Repository<UserApp>,

    @InjectRepository(Identity)
    private identitiesRepo: Repository<Identity>,

    @InjectRepository(Role)
    private rolesRepo: Repository<Role>,
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

  // ============================================
  // POOL (APP) DETAIL ENDPOINTS
  // ============================================

  async getPool(id: string) {
    const app = await this.appsRepo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('Pool not found');

    const [userCount, sessionCount] = await Promise.all([
      this.userAppsRepo.count({ where: { app_id: id } }),
      this.sessionsRepo.count({ where: { app_id: id, is_active: true } }),
    ]);

    return { ...app, userCount, sessionCount };
  }

  async getPoolUsers(poolId: string) {
    const memberships = await this.userAppsRepo.find({
      where: { app_id: poolId },
      relations: ['user', 'roles'],
      order: { created_at: 'DESC' },
    });

    return memberships.map((m) => ({
      membershipId: m.id,
      joinedAt: m.created_at,
      roles: m.roles.map((r) => r.name),
      ...m.user,
    }));
  }

  async createPoolUser(
    poolId: string,
    data: { email: string; password: string; name?: string },
    ownerId: string,
  ) {
    const pool = await this.appsRepo.findOne({ where: { id: poolId } });
    if (!pool) throw new NotFoundException('Pool not found');

    // Check email not already in this pool
    const existingIdentity = await this.identitiesRepo.findOne({
      where: { email: data.email.toLowerCase().trim(), identity_type: 'email' },
      relations: ['user'],
    });

    let user: User;
    if (existingIdentity) {
      // User exists globally — just add membership if not already in pool
      user = existingIdentity.user;
      const existing = await this.userAppsRepo.findOne({
        where: { user_id: user.id, app_id: poolId },
      });
      if (existing) throw new Error('User already in this pool');
    } else {
      // Create new user
      user = this.usersRepo.create({
        email: data.email.toLowerCase().trim(),
        name: data.name,
        email_verified: false,
        status: 'active',
        metadata: {},
      });
      user = await this.usersRepo.save(user);

      // Hash password
      const { hash } = await import('@node-rs/argon2');
      const passwordHash = await hash(data.password);

      const identity = this.identitiesRepo.create({
        user_id: user.id,
        identity_type: 'email',
        email: data.email.toLowerCase().trim(),
        password_hash: passwordHash,
        is_primary: true,
        is_verified: false,
      });
      await this.identitiesRepo.save(identity);
    }

    // Add pool membership
    const membership = this.userAppsRepo.create({
      user_id: user.id,
      app_id: poolId,
    });
    await this.userAppsRepo.save(membership);

    return user;
  }

  async updatePoolConfig(
    id: string,
    config: {
      mfa_required?: boolean;
      session_duration_hours?: number;
      oauth_redirect_uris?: string[];
      password_min_length?: number;
      password_require_uppercase?: boolean;
      password_require_numbers?: boolean;
      password_require_symbols?: boolean;
    },
  ) {
    const app = await this.appsRepo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('Pool not found');
    app.config = { ...app.config, ...config };
    return this.appsRepo.save(app);
  }

  async regeneratePoolApiKey(id: string) {
    const app = await this.appsRepo.findOne({ where: { id } });
    if (!app) throw new NotFoundException('Pool not found');
    app.api_key = `pk_${randomBytes(24).toString('hex')}`;
    app.api_secret = `sk_${randomBytes(32).toString('hex')}`;
    return this.appsRepo.save(app);
  }

  async getPoolRoles(poolId: string) {
    return this.rolesRepo.find({
      where: { app_id: poolId },
      order: { name: 'ASC' },
    });
  }

  async createPoolRole(poolId: string, data: { name: string; description?: string }) {
    const pool = await this.appsRepo.findOne({ where: { id: poolId } });
    if (!pool) throw new NotFoundException('Pool not found');
    const role = this.rolesRepo.create({
      app_id: poolId,
      name: data.name.toLowerCase().trim(),
      description: data.description,
    });
    return this.rolesRepo.save(role);
  }

  async assignUserRole(poolId: string, userId: string, roleName: string) {
    const membership = await this.userAppsRepo.findOne({
      where: { user_id: userId, app_id: poolId },
      relations: ['roles'],
    });
    if (!membership) throw new NotFoundException('User not in this pool');

    const role = await this.rolesRepo.findOne({ where: { app_id: poolId, name: roleName } });
    if (!role) throw new NotFoundException('Role not found');

    if (!membership.roles.find((r) => r.id === role.id)) {
      membership.roles = [...membership.roles, role];
      await this.userAppsRepo.save(membership);
    }
    return membership;
  }

  async removeUserRole(poolId: string, userId: string, roleName: string) {
    const membership = await this.userAppsRepo.findOne({
      where: { user_id: userId, app_id: poolId },
      relations: ['roles'],
    });
    if (!membership) throw new NotFoundException('User not in this pool');

    membership.roles = membership.roles.filter((r) => r.name !== roleName);
    await this.userAppsRepo.save(membership);
    return membership;
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
