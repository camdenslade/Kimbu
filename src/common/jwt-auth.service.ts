import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export interface JwtPayload {
  sub: string; // user_id
  app_id: string; // tenant_id
  roles: string[];
  device_id: string;
  jti: string; // JWT ID for revocation
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthService {
  constructor(private readonly jwtService: JwtService) {}

  extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  validateToken(token: string): JwtPayload {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      return payload;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  validateAndExtract(request: Request): JwtPayload {
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException('No authorization token provided');
    }

    return this.validateToken(token);
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      deviceId?: string;
    }
  }
}
