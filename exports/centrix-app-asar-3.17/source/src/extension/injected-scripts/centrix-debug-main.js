// CentriX Debug Helpers — chạy trong MAIN WORLD
// File này được manifest content_scripts inject với "world": "MAIN"
// → Bypass CSP của ChatGPT, expose functions ra DevTools Console
(function () {
	'use strict';

	if (window.__CENTRIX_DEBUG_LOADED__) return;
	window.__CENTRIX_DEBUG_LOADED__ = true;

	const SEC_KEY    = 'centrix_security_warning_ack';
	const NOTICE_LAST = 'centrix_notice_last_shown';
	const NOTICE_ACK  = 'centrix_notice_ack';
	const NOTICE_DIS  = 'centrix_notice_dismissed_ver';
	const DEVICE_KEY  = 'centrix_device_id';
	const QUEUE_KEY   = 'centrix_consent_queue';

	window.centrixShowAllPopups = function () {
		[SEC_KEY, NOTICE_LAST, NOTICE_ACK, NOTICE_DIS].forEach(k => localStorage.removeItem(k));
		console.log('[CentriX] flags reset, reload trang...');
		setTimeout(() => location.reload(), 100);
	};

	window.centrixShowNotice = function () {
		[NOTICE_LAST, NOTICE_ACK, NOTICE_DIS].forEach(k => localStorage.removeItem(k));
		console.log('[CentriX] notice flags reset, reload trang...');
		setTimeout(() => location.reload(), 100);
	};

	window.centrixShowSecurityWarning = function () {
		localStorage.removeItem(SEC_KEY);
		console.log('[CentriX] security flag reset, reload trang...');
		setTimeout(() => location.reload(), 100);
	};

	window.centrixResetAll = function () {
		[SEC_KEY, NOTICE_LAST, NOTICE_ACK, NOTICE_DIS, DEVICE_KEY, QUEUE_KEY].forEach(k => localStorage.removeItem(k));
		console.log('[CentriX] tất cả flags + device ID + queue đã reset. Reload trang để test lại.');
	};

	window.centrixGetDeviceId = function () {
		const id = localStorage.getItem(DEVICE_KEY);
		console.log('[CentriX] device ID:', id || '(chưa có)');
		return id;
	};

	window.centrixStatus = function () {
		const status = {
			security_acked: localStorage.getItem(SEC_KEY),
			notice_acked: localStorage.getItem(NOTICE_ACK),
			notice_last_shown: localStorage.getItem(NOTICE_LAST) ? new Date(parseInt(localStorage.getItem(NOTICE_LAST))).toLocaleString('vi-VN') : null,
			notice_dismissed_forever: localStorage.getItem(NOTICE_DIS),
			device_id: localStorage.getItem(DEVICE_KEY),
			pending_consent_queue: (() => {
				try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]').length; }
				catch (e) { return 0; }
			})()
		};
		console.table(status);
		return status;
	};

	console.log('%c[CentriX] Debug commands ready', 'color:#10b981;font-weight:bold');
	console.log('  centrixShowAllPopups()      — reset cả 2 popup');
	console.log('  centrixShowNotice()         — reset privacy notice');
	console.log('  centrixShowSecurityWarning()— reset security warning');
	console.log('  centrixResetAll()           — reset toàn bộ');
	console.log('  centrixGetDeviceId()        — xem device ID');
	console.log('  centrixStatus()             — xem trạng thái hiện tại');
})();
