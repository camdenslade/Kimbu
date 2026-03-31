import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthService, JwtPayload } from '../jwt-auth.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtAuthService: JwtAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    try {
      const payload: JwtPayload = this.jwtAuthService.validateAndExtract(request);
      request.user = payload;
      request.deviceId = payload.device_id;
      return true;
    } catch (error: any) {
      throw new UnauthorizedException(error?.message || 'Invalid token');
    }
  }
}
