const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2019,
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'warn',
            'prefer-const': 'warn',
            'no-var': 'warn',
            eqeqeq: ['error', 'always'],
        },
    },
    {
        files: ['src/highlights.ts', 'src/tree.ts'],
        rules: {
            'prefer-const': 'off',
            'no-var': 'off',
        },
    },
    {
        ignores: ['dist/', 'node_modules/', 'scanner/target/', '*.js'],
    },
];
