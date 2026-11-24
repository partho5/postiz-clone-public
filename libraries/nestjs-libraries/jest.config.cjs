// Integration tests that need a real Postgres. Run from the repo root:
//   TEST_DATABASE_URL=postgresql://... pnpm run test:integration
module.exports = {
  displayName: 'nestjs-libraries',
  testEnvironment: 'node',
  rootDir: '../..',
  roots: ['<rootDir>/libraries/nestjs-libraries/src'],
  testMatch: ['**/*.spec.ts'],
  setupFiles: ['<rootDir>/libraries/nestjs-libraries/jest.env.cjs'],
  // Migrates the test database and creates the API role
  globalSetup:
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/credits/scope/money.roles.setup.ts',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/libraries/nestjs-libraries/tsconfig.spec.json',
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
  },
  testTimeout: 60000,
};
