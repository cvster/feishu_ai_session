#!/usr/bin/env python3
"""Text-only A2A 1.0 HTTP+JSON client for a shared project assistant."""
import argparse
import json
import os
import sys
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, quote
from urllib.request import HTTPRedirectHandler, Request, build_opener, ProxyHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward credentials to a redirect destination.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent-card', required=True, help='Authenticated Agent Card URL')
    parser.add_argument('--token-env', default='A2A_TOKEN', help='Environment variable containing the access token')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--question', help='One new project question or debugging task')
    action.add_argument('--get', metavar='TASK_ID', help='Query and wait for an existing task')
    action.add_argument('--cancel', metavar='TASK_ID', help='Cancel only this task')
    parser.add_argument('--request-id', help='Stable messageId; reuse it only for the identical request')
    parser.add_argument('--watch', action='store_true', help='Print updated full text snapshots as they arrive')
    parser.add_argument('--timeout', type=float, default=1800, help='Maximum polling duration in seconds; does not cancel execution')
    args = parser.parse_args()
    token = os.environ.get(args.token_env)
    if not token:
        parser.error('Missing access token environment variable: ' + args.token_env)
    origin = urlsplit(args.agent_card)
    if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password:
        parser.error('Agent Card must be an HTTP(S) URL without credentials')
    opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(url, body=None):
        headers = {'Authorization': 'Bearer ' + token, 'A2A-Version': '1.0', 'Accept': 'application/json'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        with opener.open(Request(url, data=data, headers=headers), timeout=30) as response:
            return json.load(response)

    card = request(args.agent_card)
    interfaces = [item for item in card.get('supportedInterfaces', [])
                  if item.get('protocolBinding') == 'HTTP+JSON' and item.get('protocolVersion') == '1.0']
    if not interfaces:
        parser.error('No supported A2A 1.0 HTTP+JSON interface in Agent Card')
    base = interfaces[0]['url'].rstrip('/')
    target = urlsplit(base)
    if (target.scheme, target.hostname, target.port) != (origin.scheme, origin.hostname, origin.port) or target.username or target.password:
        parser.error('Refusing to send the credential to an interface on a different origin')
    if args.question:
        message_id = args.request_id or str(uuid.uuid4())
        print('messageId=' + message_id, file=sys.stderr, flush=True)
        result = request(base + '/message:send', {
            'message': {'messageId': message_id, 'role': 'ROLE_USER', 'parts': [{'text': args.question}]},
            'configuration': {'returnImmediately': True, 'historyLength': 0},
        })
        task = result['task']
    else:
        task_id = quote(args.get or args.cancel, safe='')
        task = request(base + '/tasks/' + task_id + (':cancel' if args.cancel else ''), {} if args.cancel else None)
    print('taskId=' + task['id'], file=sys.stderr, flush=True)
    deadline = time.monotonic() + args.timeout
    previous = None
    while True:
        state = task['status']['state']
        text = '\n\n'.join(part['text'] for artifact in task.get('artifacts', [])
                           for part in artifact.get('parts', []) if 'text' in part)
        if args.watch and text != previous:
            print(text, flush=True)  # Full replacement snapshots, never assumed deltas.
            previous = text
        if state not in ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_AUTH_REQUIRED'):
            if not args.watch:
                print(text)
            print('status=' + state, file=sys.stderr)
            notice = task['status'].get('message', {}).get('parts', [])
            if notice:
                print('\n'.join(part.get('text', '') for part in notice), file=sys.stderr)
            return 0 if state in ('TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED') else 1
        if time.monotonic() >= deadline:
            print('Polling timed out; execution was not canceled. Query the same taskId; do not submit a new task.', file=sys.stderr)
            return 2
        time.sleep(1 if state != 'TASK_STATE_AUTH_REQUIRED' else 3)
        task = request(base + '/tasks/' + quote(task['id'], safe=''))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except HTTPError as error:
        print('HTTP ' + str(error.code) + ': ' + error.read(8192).decode('utf-8', 'replace'), file=sys.stderr)
        sys.exit(1)
    except (URLError, TimeoutError, OSError) as error:
        print('Connection failed; no automatic resubmission. Query the original taskId or retry the identical messageId: ' + str(error), file=sys.stderr)
        sys.exit(2)
