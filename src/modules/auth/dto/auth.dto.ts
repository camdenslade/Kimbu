import { IsEmail, IsString, IsOptional, MinLength, Matches, IsPhoneNumber, IsUUID } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/,
    {
      message: 'Password must contain uppercase, lowercase, number, and special character',
    },
  )
  password!: string;

  @IsOptional()
  @IsString()
  name?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RequestOtpDto {
  @IsPhoneNumber()
  phoneNumber!: string;
}

export class VerifyOtpDto {
  @IsPhoneNumber()
  phoneNumber!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  otp!: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken!: string;
}

export class LogoutDto {
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsOptional()
  metadata?: Record<string, any>;
}

export class LinkIdentityDto {
  @IsString()
  method!: 'email' | 'phone' | 'oauth';

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  token?: string;
}

export class UnlinkIdentityDto {
  @IsUUID()
  identityId!: string;
}

export class ChangePasswordDto {
  @IsString()
  oldPassword!: string;

  @IsString()
  @MinLength(8)
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/,
    {
      message: 'Password must contain uppercase, lowercase, number, and special character',
    },
  )
  newPassword!: string;
}

export class OAuthLoginDto {
  @IsString()
  provider!: 'google' | 'apple' | 'github';

  @IsString()
  code!: string;

  @IsOptional()
  @IsString()
  redirectUri?: string;
}
