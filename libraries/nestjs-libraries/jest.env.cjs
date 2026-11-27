// Integration tests: the sign-in code resend cooldown is off, so a test can ask for several codes for one address.
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
