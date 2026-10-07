#!/usr/bin/env python3
"""启动入口：初始化数据库（空库则灌入演示数据并发布），然后启动服务。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kiln.db import DB
from kiln.seed import seed
from kiln.server import serve

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('KILN_DB', os.path.join(BASE, 'kiln.db'))
PUBLIC_DIR = os.path.join(BASE, 'public')
PORT = int(os.environ.get('PORT', '8000'))

if __name__ == '__main__':
    db = DB(DB_PATH)
    if db.one('SELECT id FROM exhibits LIMIT 1') is None:
        print('空数据库，灌入演示数据并首次发布…')
        result = seed(db, PUBLIC_DIR)
        print('首次发布完成: build #%s' % result['run_id'])
    serve(db, PUBLIC_DIR, port=PORT)
