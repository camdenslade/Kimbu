export class TokenResponse {
  accessToken!: string;
  refreshToken!: string;
  expiresIn!: number;
}

export class UserResponse {
  id!: string;
  email?: string;
  phone?: string;
  name?: string;
  avatar?: string;
  emailVerified!: boolean;
  phoneVerified!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
  metadata?: Record<string, any>;
}

export class AuthResponse {
  user!: UserResponse;
  tokens!: TokenResponse;
  isNewUser!: boolean;
}

export class IdentityResponse {
  id!: string;
  userId!: string;
  method!: string;
  email?: string;
  phone?: string;
  providerAccountId?: string;
  createdAt!: Date;
  isPrimary!: boolean;
}

export class SessionResponse {
  id!: string;
  deviceId!: string;
  deviceName!: string;
  deviceType!: string;
  userAgent!: string;
  ipAddress!: string;
  lastActiveAt!: Date;
  createdAt!: Date;
  isCurrent!: boolean;
}

export class AuditLogResponse {
  id!: string;
  userId!: string;
  eventType!: string;
  status!: string;
  provider!: string;
  ipAddress!: string;
  deviceId!: string;
  failureReason?: string;
  createdAt!: Date;
}

export class ErrorResponse {
  code!: string;
  message!: string;
  details?: any;
  timestamp!: Date;
}

export class MessageResponse {
  message!: string;
}
