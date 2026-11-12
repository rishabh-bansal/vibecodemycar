# Contributing to Vibecode my car

Thanks for helping. Every car that gets added, every recipe that gets checked on a real car, and every quirk
someone writes down makes the app safer and more useful for the next person.

## Ways to help

| | What | How |
|---|---|---|
| 🚗 | **Add a car** — a model, variant or market not listed yet | [docs/contributing/adding-a-car.md](docs/contributing/adding-a-car.md) |
| 🔧 | **Add or fix a feature** — a coding recipe | [docs/contributing/adding-a-feature.md](docs/contributing/adding-a-feature.md) |
| 📒 | **Share a finding** — what you learned on your car | [docs/contributing/sharing-a-finding.md](docs/contributing/sharing-a-finding.md) |
| 🐞 | **Report a bug** | [New issue → Bug](https://github.com/rishabh-bansal/vibecodemycar/issues/new?template=bug.yml) |

You don't need to write code to help: findings and "this worked / didn't work on my car" reports are some of the
most valuable contributions. Open an issue with the matching template.

## Ground rules

- **Never post your VIN, registration number, or adapter / control-unit serial numbers.** Mask them
  (`MEX…1234`). Part numbers (like `2Q0937089D`) are fine and useful.
- **Say how you know.** "Coded and read back on my 2023 Kushaq, BCM 2Q0937089D" is evidence; "a forum post
  says" is a lead. Both are welcome — label which one it is.
- **Only add sources you're allowed to share.** Don't paste data copied out of paid or closed tools (VCDS label
  files, ODIS datasets, other apps' databases). Your own measurements and your own words are always fine.
- **Safety first.** A recipe that writes to a car must say which control unit, which DID, which bytes, and what
  it was before. If it touches brakes, airbags, steering or engine, say so in the PR title.
- Be kind. Many contributors are car owners, not programmers.

## Pull requests

1. Fork the repo and create a branch.
2. Make your change. For data changes run `npm run data`.
3. Run `npm run check` (typecheck, lint, data check, tests, build). CI runs the same.
4. Open the PR and fill in the template, including the contribution-terms checkbox.

Small, focused PRs are easiest to review: one car, one feature, or one finding at a time.

## Contribution terms

By submitting a contribution (code, data, documentation, images, findings or anything else) to this repository,
you agree that:

1. **You have the right to submit it.** It is your own work, or you have permission to share it, and it does not
   include material you aren't allowed to share (such as data copied from paid or closed tools).
2. **You keep your copyright,** and you grant Rishabh Bansal (the project owner) a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, distribute, sublicense and
   relicense your contribution, as part of Vibecode my car or otherwise.
3. **Your contribution is covered by the project [LICENSE](LICENSE)** for everyone else.
4. You provide it as is, without warranty.

These terms let the project keep one owner and one license while accepting help from many people.

## Code of conduct

Be respectful and assume good faith. Harassment, personal attacks and sharing other people's personal data
(including VINs) aren't tolerated; such content is removed and repeat offenders are blocked.
