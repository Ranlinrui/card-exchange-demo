#!/usr/bin/env python3
"""Your own Python upstream adapter starting point.

Implement only against resources you own or are allowed to use. Load your local
credentials inside this process (never print them). Do not use customer values
as shell commands or URLs. Resolve the original merchant_order_id on query;
never issue a second purchase because a previous result was uncertain.

stdout must contain exactly one contract JSON object. Diagnostics must not
contain secrets or personal data. The server discards stderr. This template
intentionally performs no network operations and never claims delivery success.
"""
import json
import sys


def handle(request):
    if request.get('operation') not in ('submit', 'query'):
        return {'status': 'unknown'}
    # Supply your own original-order lookup and permitted purchase automation.
    # A pending/manual login/captcha/payment click is not a completed delivery.
    return {'status': 'action_required', 'error_code': 'OWNER_CONFIGURATION_REQUIRED'}


if __name__ == '__main__':
    try:
        response = handle(json.load(sys.stdin))
    except Exception:
        response = {'status': 'unknown'}
    print(json.dumps(response))
