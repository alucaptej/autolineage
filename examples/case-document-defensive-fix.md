# AutoLineage case case_ms5srde8j38qps

**Expectation**: curated-events-fed-by-raw-events — curated_events must be lineage-connected to raw_events through the merge_upsert_curated Spark job
**Incident**: urn:li:incident:8ce039bd-1b15-4609-a7a3-af0237772c93
**Fix PR**: https://github.com/alucaptej/autolineage-demo-pipelines/pull/5 (verified SHA `ceed262379db139d75c0d3e72e1a4fb9f12dcf44`, attempts: 0)

## Detector evidence
```json
{"expectation_id":"curated-events-fed-by-raw-events","downstream":"urn:li:dataset:(urn:li:dataPlatform:file,/private/tmp/lakehouse/curated_events,PROD)","upstream":"urn:li:dataset:(urn:li:dataPlatform:file,/private/tmp/lakehouse/raw_events,PROD)","run_marker":"2026-07-29T08:01:08.946Z","observed":{"dataset_exists":true,"edge_last_modified":1785281775212,"fresh_edges":false,"fragment_candidates":["urn:li:dataset:(urn:li:dataPlatform:file,data/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,verify-case-test./private/tmp/lakehouse/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,verify-case_ms4xo5o0o92kim./private/tmp/lakehouse/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,/Users/ww/hack/autolineage-demo-pipelines/data/curated_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,data/raw_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,/Users/ww/hack/autolineage-demo-pipelines/data/raw_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,verify-case-test./private/tmp/lakehouse/raw_events,PROD)","urn:li:dataset:(urn:li:dataPlatform:file,verify-case_ms4xo5o0o92kim./private/tmp/lakehouse/raw_events,PROD)"],"signature_hint":"silent-pipeline"}}
```

## Agent diagnosis (from the PR body)
Automated bounded change for WORK_ms5srdi7itperr.

🤖 wg2 engine

_Resolved automatically by [AutoLineage](https://github.com/alucaptej/autolineage): candidate validated pre-merge in an isolated namespace, merged by exact SHA, canonical graph confirmed post-merge._
