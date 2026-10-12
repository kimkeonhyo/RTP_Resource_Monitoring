#!/bin/sh
# PoC용 알림 수신기 — 외부로 보내지 않고 파일에 적는다.
# $1 받는사람  $2 제목  $3 본문
printf '[%s]\nTO: %s\nSUBJECT: %s\n%s\n---\n' "$(date '+%F %T')" "$1" "$2" "$3" >> /var/log/zbx-notify/alerts.log
