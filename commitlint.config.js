const { RuleConfigSeverity } = require("@commitlint/types");

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [RuleConfigSeverity.Error, "always", 500],
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "chore",
        "style",
        "refactor",
        "ci",
        "test",
        "revert",
        "perf",
        "vercel",
      ],
    ],
  },
};
