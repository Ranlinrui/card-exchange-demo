#!/usr/bin/env python3
"""Synthetic-only upstream. It does not access a network or purchase anything."""
import hashlib
import json
import sys


def main():
    request = json.load(sys.stdin)
    order = request.get('merchant_order_id', '')
    reference = 'SYNTHETIC-' + hashlib.sha256(order.encode()).hexdigest()[:16]
    if request.get('operation') == 'submit':
        result = {'status': 'processing', 'reference': reference}
    elif request.get('operation') == 'query':
        suffix = hashlib.sha256(order.encode()).hexdigest()[:12].upper()
        if request.get('product', {}).get('kind') == 'account':
            delivery = {'kind': 'account', 'email': 'demo@example.invalid', 'password': 'SYNTHETIC-' + suffix, 'totp_secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'}
        else:
            delivery = {'kind': 'code', 'text': 'DEMO-' + suffix}
        result = {'status': 'succeeded', 'reference': reference, 'delivery': delivery}
    else:
        result = {'status': 'unknown'}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
