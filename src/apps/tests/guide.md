Tests fills itself from test commands you run in Bash (npm test, vitest, jest, pytest, go test,
cargo test…). Let the runner's summary through: `| tail -n 30` is fine, but filtering it out with
grep or `> /dev/null` leaves the Tests window without counts.
