import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Role, Permission, User } from '../../database/entities';
import { JwtPayload } from '../jwt-auth.service';

export const PERMISSIONS_KEY = 'permissions';

export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectRepository(User) private usersRepository: Repository<User>,
    @InjectRepository(Role) private rolesRepository: Repository<Role>,
    @InjectRepository(Permission) private permissionsRepository: Repository<Permission>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.get<string[]>(PERMISSIONS_KEY, context.getHandler());

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true; // No permission requirement, allow access
    }

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    if (!user) {
      throw new ForbiddenException('User information not available');
    }

    // Get user roles for the app
    const userWithRoles = await this.usersRepository.findOne({
      where: { id: user.sub },
      relations: ['app_memberships.roles.permissions'],
    });

    if (!userWithRoles) {
      throw new ForbiddenException('User not found');
    }

    // Get all permissions for the user in the app
    const userPermissions = new Set<string>();
    if (userWithRoles.app_memberships && Array.isArray(userWithRoles.app_memberships)) {
      userWithRoles.app_memberships.forEach((userApp: any) => {
        if (userApp.app_id === user.app_id && userApp.roles && Array.isArray(userApp.roles)) {
          userApp.roles.forEach((role: any) => {
            if (role.permissions && Array.isArray(role.permissions)) {
              role.permissions.forEach((permission: any) => {
                userPermissions.add(`${permission.resource}:${permission.action}`);
              });
            }
          });
        }
      });
    }

    // Check if user has any required permission
    const hasPermission = requiredPermissions.some((permission) =>
      userPermissions.has(permission),
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `This action requires one of the following permissions: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
