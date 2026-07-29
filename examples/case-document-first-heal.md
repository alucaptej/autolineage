# AutoLineage case case_ms4xo5o0o92kim

**Expectation**: curated-events-fed-by-raw-events — curated_events must be lineage-connected to raw_events through the merge_upsert_curated Spark job
**Incident**: urn:li:incident:24efa153-a224-4648-afda-8fa8f777db50
**Fix PR**: https://github.com/alucaptej/autolineage-demo-pipelines/pull/2 (verified SHA `f6fb074f9208b345a5797c5db79d90b1415da438`, attempts: 0)

## Detector evidence
```json
{"expectation_id":"curated-events-fed-by-raw-events","downstream":"urn:li:dataset:(urn:li:dataPlatform:file,/private/tmp/lakehouse/curated_events,PROD)","upstream":"urn:li:dataset:(urn:li:dataPlatform:file,/private/tmp/lakehouse/raw_events,PROD)","run_marker":"2026-07-28T17:30:50.442Z","observed":{"dataset_exists":true,"edge_last_modified":1785259849246,"fresh_edges":true,"fragment_candidates":["urn:li:dataset:(urn:li:dataPlatform:file,data/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,verify-case-test./private/tmp/lakehouse/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,/Users/ww/hack/autolineage-demo-pipelines/data/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,data/raw_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,/Users/ww/hack/autolineage-demo-pipelines/data/raw_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,verify-case-test./private/tmp/lakehouse/raw_events,PROD)"],"signature_hint":"stale-or-fragmented"}}
```

## Agent diagnosis (from the PR body)
Automated bounded change for WORK_ms4xo5r2j6jfw8.

🤖 wg2 engine

_Resolved automatically by [AutoLineage](https://github.com/alucaptej/autolineage): candidate validated pre-merge in an isolated namespace, merged by exact SHA, canonical graph confirmed post-merge._
