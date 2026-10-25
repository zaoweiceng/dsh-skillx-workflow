"""Create isolated synthetic data; the audit itself only reads training/holdout."""
import hashlib
import json
from pathlib import Path
import tempfile

root = Path(tempfile.mkdtemp(prefix="skillx-e2e-"))
for batch, n in [("training", 3), ("holdout", 2)]:
    base = root / batch
    base.mkdir()
    regions = []
    expected = dict(regions=n, projects=n*n, packages=n*n*n,
                    artifactMismatches=0, csvIssueCount=0, brokenLinks=0,
                    failedPackages=0, amountTotal=0)
    for r in range(n):
        region = base / f"区域 {r}"
        region.mkdir()
        regions.append(dict(id=f"r{r}", path=region.name))
        projects = []
        for p in range(n):
            project = region / f"项目 {p}"
            project.mkdir()
            projects.append(dict(id=f"p{p}", path=project.name))
            packages = []
            for k in range(n):
                index = r*n*n + p*n + k
                package = project / f"数据包 {k}"
                package.mkdir()
                packages.append(dict(id=f"k{k}", path=package.name))
                data = f"fixture {batch} {index}\n".encode()
                (package / "artifact.txt").write_bytes(data)
                bad_hash, bad_csv, bad_link = index % 5 == 0, index % 4 == 0, index % 3 == 0
                manifest = dict(artifact=dict(path="artifact.txt", sha256="0"*64 if bad_hash else hashlib.sha256(data).hexdigest()),
                                csv="data.csv", docs=["README.md"], allowedStatuses=["ready", "pending"])
                (package / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                (package / "data.csv").write_text("id,amount,status\nA,10,ready\nB,20,pending\n" +
                    ("B,nope,invalid\n" if bad_csv else "C,30,ready\n") + "D,5.5,ready\n", encoding="utf-8")
                (package / "README.md").write_text("# Fixture\n[artifact](artifact.txt)\n[data](data.csv)\n" +
                    ("[missing](missing.txt)\n" if bad_link else "[manifest](manifest.json)\n") +
                    "[external](https://example.com/)\n", encoding="utf-8")
                expected["artifactMismatches"] += bad_hash
                expected["csvIssueCount"] += 3 * bad_csv
                expected["brokenLinks"] += bad_link
                expected["failedPackages"] += bad_hash or bad_csv or bad_link
                expected["amountTotal"] += 35.5 if bad_csv else 65.5
            (project / "project.json").write_text(json.dumps(dict(packages=packages), ensure_ascii=False), encoding="utf-8")
        (region / "region.json").write_text(json.dumps(dict(projects=projects), ensure_ascii=False), encoding="utf-8")
    (base / "batch.json").write_text(json.dumps(dict(regions=regions), ensure_ascii=False), encoding="utf-8")
    (root / f"{batch}-expected.json").write_text(json.dumps(expected), encoding="utf-8")
    (root / f"{batch}-hashes.json").write_text(json.dumps({str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in base.rglob("*") if p.is_file()}), encoding="utf-8")
print(root)
