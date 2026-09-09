'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  // A leaked handle (fs op, timer, etc.) must fail the run fast, not hang it. A
  // test that hung `mkdirSync` on a Linux CI runner once blocked `npm test`
  // silently for 6h, which is a prerequisite of the publish workflow — the
  // release never ran and nothing said why. forceExit trades hiding a real leak
  // for never blocking CI again; testTimeout catches a stuck individual test in
  // seconds instead of waiting for the whole suite to hang.
  forceExit: true,
  testTimeout: 15000,
  collectCoverageFrom: ['src/**/*.js', 'bin/**/*.js', '!src/rules/**'],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'html'],
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
    },
  },
};
