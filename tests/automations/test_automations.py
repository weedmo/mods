#!/usr/bin/env python3
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/herdr-automations'))
import schedule
from store import Store, definition
from hc_adapter import classify, CoreError
from runner import precheck
from service import Controller


def epoch(s):
    return datetime.fromisoformat(s).timestamp()

def config(cwd='/tmp', **extra):
    return {'name':'검토', 'cwd':cwd, 'agent':'codex', 'prompt':'검토해줘', 'enabled':True,
            'schedule':{'kind':'daily','hour':9,'minute':0,'timezone':'Asia/Seoul'}, **extra}

class ScheduleTests(unittest.TestCase):
    def test_seoul_and_strict_after(self):
        s = config()['schedule']; t = epoch('2026-11-05T00:00:00+00:00')
        self.assertEqual(schedule.occurrences(s,t)[0], t+86400)
        self.assertEqual(schedule.latest(s,t),t)
    def test_weekdays_and_weekly(self):
        t = epoch('2026-11-06T01:00:00+00:00')
        s = {**config()['schedule'],'kind':'weekdays'}
        self.assertEqual(schedule.occurrences(s,t)[0],epoch('2026-11-09T00:00:00+00:00'))
        s.update(kind='weekly',weekday=0)
        self.assertEqual(schedule.occurrences(s,t)[0],epoch('2026-11-09T00:00:00+00:00'))
    def test_dst_gap(self):
        s = {'kind':'daily','hour':2,'minute':30,'timezone':'America/New_York'}
        self.assertEqual(schedule.occurrences(s,epoch('2026-03-08T00:00:00+00:00'))[0], epoch('2026-03-09T06:30:00+00:00'))
    def test_dst_fold_once(self):
        s = {'kind':'daily','hour':1,'minute':30,'timezone':'America/New_York'}
        first = epoch('2026-11-01T05:30:00+00:00')
        self.assertEqual(schedule.occurrences(s,first-1)[0],first)
        self.assertEqual(schedule.occurrences(s,first)[0],epoch('2026-11-02T06:30:00+00:00'))
    def test_invalid(self):
        for patch_value in [{'kind':'cron'}, {'minute':True}, {'hour':24}, {'timezone':'bad/zone'}]:
            with self.assertRaises(ValueError): schedule.validate({**config()['schedule'],**patch_value})

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.path = Path(self.tmp.name)/'db'
        self.store = Store(self.path); self.now = epoch('2026-11-04T23:59:00+00:00')
        self.d = self.store.save(config(),request_id='create-one',now=self.now)
    def tearDown(self):
        self.store.close(); self.tmp.cleanup()
    def test_validation(self):
        for value in [{'cwd':'relative'}, {'agent':'sh'}, {'enabled':1}, {'graceMinutes':-1}, {'precheck':{'timeout':0}}, {'machine':'remote'}]:
            with self.assertRaises(ValueError): definition(config(**value))
    def test_duplicate_manual_and_snapshot(self):
        r = self.store.manual(self.d['id'],'request-1',now=self.now)
        self.assertEqual(self.store.manual(self.d['id'],'request-1')['id'],r['id'])
        self.assertEqual(self.store.manual(self.d['id'],'request-2')['phase'],'skipped_overlap')
        changed = self.store.save(config(prompt='new'),id=self.d['id'],revision=1,request_id='update-one')
        self.assertEqual(self.store.run(r['id'])['snapshot']['prompt'],'검토해줘')
        with self.assertRaises(ValueError): self.store.save(config(),id=self.d['id'],revision=1,request_id='update-two')
        self.assertEqual(changed['revision'],2)
    def test_due_once_and_restart(self):
        t=self.now+61
        self.assertEqual(self.store.due(t)[0]['phase'],'queued')
        self.store.close();self.store=Store(self.path)
        self.assertEqual(self.store.due(t+1),[])
        self.assertEqual(self.store.due(self.now-86400),[])
        self.assertEqual(len(self.store.runs()),1)
    def test_catchup_and_missed(self):
        r = self.store.due(self.now+86400*100+61)
        self.assertEqual(r[0]['phase'],'queued')
        self.assertEqual([r['phase'] for r in self.store.runs()].count('skipped_missed'),1)
    def test_outside_grace(self):
        self.assertEqual(self.store.due(self.now+3600)[0]['phase'],'skipped_missed')
    def test_pause_resume(self):
        d=self.store.save(config(enabled=False),id=self.d['id'],revision=1,request_id='pause-one',now=self.now)
        self.assertEqual(self.store.due(self.now+86400),[])
        d=self.store.save(config(),id=d['id'],revision=d['revision'],request_id='resume-one',now=self.now+86400)
        self.assertGreater(d['nextRunAt'],self.now+86400)
    def test_archive_and_retention(self):
        for i in range(103):
            r=self.store.manual(self.d['id'],f'request-{i}',now=self.now+i)
            self.store.set_run(r['id'],phase='succeeded')
        active=self.store.manual(self.d['id'],'still-active',now=self.now+200)
        self.store.prune()
        self.assertEqual(len(self.store.runs(limit=1000)),101)
        self.assertEqual(self.store.run(active['id'])['phase'],'queued')
        self.assertEqual(self.store.manual(self.d['id'],'request-0')['id'],self.store.cached('request-0','run:'+self.d['id'])['id'])
        self.store.archive(self.d['id'],1)
        self.assertEqual(self.store.list(),[])
        with self.assertRaises(ValueError): self.store.manual(self.d['id'],'after-archive')
    def test_idempotency_rejects_changed_payload(self):
        self.assertEqual(self.store.save(config(),request_id='create-one')['id'],self.d['id'])
        with self.assertRaises(ValueError):
            self.store.save(config(prompt='different'),request_id='create-one')
        self.assertEqual(len(self.store.list()),1)
    def test_failed_request_rolls_back(self):
        with self.assertRaises(ValueError): self.store.save(config(agent='bad'),request_id='bad-create')
        self.assertEqual(len(self.store.list()),1)

class Core:
    def __init__(self): self.id='core1'; self.candidates=[]; self.term=None
    def identity(self): return self.id
    def find(self,id): return self.candidates
    def get(self,address): return self.term
    def read(self,address): return 'result'

class RecoveryTests(unittest.TestCase):
    setUp = StoreTests.setUp
    tearDown = StoreTests.tearDown
    def test_reconcile_response_loss(self):
        r=self.store.manual(self.d['id'],'launch-lost')
        self.store.set_run(r['id'],phase='dispatching',coreId='core1')
        core=Core(); core.candidates=[{'address':'t42'}]
        core.term={'address':'t42','state':'live','labels':{'herdr.automation.run':r['id']},'created_ms':1000,'turn':1,'status_ms':2000,'status':{'state':'done'}}
        c=Controller(self.store,core)
        try:
            c.reconcile(self.now)
            r=self.store.run(r['id']);self.assertEqual(r['address'],'t42');self.assertEqual(r['phase'],'succeeded')
        finally:c.close()
    def test_uncertain_and_changed_core(self):
        r=self.store.manual(self.d['id'],'launch-lost')
        self.store.set_run(r['id'],phase='dispatching',coreId='core1')
        core=Core(); c=Controller(self.store,core)
        try:
            c.reconcile(self.now); self.assertEqual(self.store.run(r['id'])['phase'],'unknown')
            core.id='other';c.reconcile(self.now)
            self.assertIn('identity',self.store.run(r['id'])['message'])
        finally:c.close()
    def test_labels_and_initial_failure_fenced(self):
        r=self.store.manual(self.d['id'],'label-mismatch')
        self.store.set_run(r['id'],phase='running',coreId='core1',address='t42')
        core=Core();core.term={'labels':{'herdr.automation.run':'someone-else'}}
        c=Controller(self.store,core)
        try:
            c.reconcile(self.now)
            self.assertEqual(self.store.run(r['id'])['phase'],'unknown')
            with self.assertRaises(ValueError): c.request({'op':'openTerminal','id':r['id']})
        finally:c.close()
    def test_ui_summaries_bounded(self):
        r=self.store.manual(self.d['id'],'summary-check')
        c=Controller(self.store,Core())
        try:
            self.assertNotIn('prompt',c.request({'op':'list'})[0])
            self.assertNotIn('snapshot',c.request({'op':'runs'})[0])
            self.assertIn('snapshot',c.request({'op':'getRun','id':r['id']}))
        finally:c.close()
    def test_precheck_crash(self):
        r=self.store.manual(self.d['id'],'precheck-crash');self.store.set_run(r['id'],phase='prechecking')
        c=Controller(self.store,Core())
        self.assertEqual(self.store.run(r['id'])['phase'],'interrupted');c.close()

class RunnerTests(unittest.TestCase):
    def test_precheck(self):
        self.assertTrue(precheck('printf yes','/tmp',1)['passed'])
        self.assertFalse(precheck('exit 2','/tmp',1)['passed'])
        self.assertTrue(precheck('sleep 10','/tmp',.1)['timedOut'])
        r=precheck("head -c 20000 /dev/zero",'/tmp',1)
        self.assertTrue(r['passed']);self.assertEqual(len(r['output']),4000)
    def test_prompt_is_never_an_option(self):
        from hc_adapter import HC
        core=HC()
        r={'id':'run','automationId':'auto','snapshot':config(prompt='--dangerously-bypass-approvals-and-sandbox')}
        with patch('hc_adapter.shutil.which',return_value='/bin/codex'), patch.object(core,'call',return_value={'address':'t1'}) as call:
            core.launch(r)
            self.assertEqual(call.call_args.args[-3:],('--no-daemon','--',r['snapshot']['prompt']))
    def test_no_initial_idle_success(self):
        r={'createdAt':0}
        t={'state':'live','created_ms':0,'turn':0,'status_ms':1,'status':{'state':'idle'}}
        self.assertEqual(classify(t,r,1)[0],'running')
        self.assertEqual(classify(t,r,91)[0],'blocked')
        t.update(turn=1,status={'state':'done'})
        self.assertEqual(classify(t,r,91)[0],'succeeded')
        t['status']={'state':'blocked'};self.assertEqual(classify(t,r,91)[0],'blocked')
        t.update(state='finished',exit_code=0);self.assertEqual(classify(t,r,91)[0],'interrupted')

if __name__ == '__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
    if result.wasSuccessful(): print('AUTOMATIONS_TESTS_PASSED')
    sys.exit(not result.wasSuccessful())
