// CentriX Popups Loader v1.2
// Thay đổi v1.2:
//   - Soften màu popup security (chuyển từ đỏ chói → amber dịu)
//   - Bỏ animation pulse, giảm shadow
//   - Guard chống double-load
//   - Thêm gửi consent về backend làm evidence (có thể tắt qua flag)
(function () {
	'use strict';

	// ============================================================
	// GUARD chống double-load (khi script bị inject 2 lần)
	// ============================================================
	if (window.__CENTRIX_POPUPS_LOADED__) {
		console.log('[CentriX Popups] already loaded, skip');
		return;
	}
	window.__CENTRIX_POPUPS_LOADED__ = true;

	// ============================================================
	// CONFIG
	// ============================================================
	const API_ENDPOINT = 'https://api.centrix.im/v1/consent';
	const ENABLE_BACKEND_TRACKING = false; // Tắt mặc định, bật khi backend ready

	function getDeviceId() {
		let id = localStorage.getItem('centrix_device_id');
		if (!id) {
			id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
			localStorage.setItem('centrix_device_id', id);
		}
		return id;
	}

	function trackConsent(type, version, extra = {}) {
		if (!ENABLE_BACKEND_TRACKING) return;
		const payload = {
			type, version,
			device_id: getDeviceId(),
			timestamp: new Date().toISOString(),
			user_agent: navigator.userAgent,
			screen: `${screen.width}x${screen.height}`,
			language: navigator.language,
			url: location.hostname,
			...extra
		};
		try {
			fetch(API_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
				keepalive: true,
				credentials: 'omit'
			}).catch(() => queueFailedConsent(payload));
		} catch (e) {
			queueFailedConsent(payload);
		}
	}

	function queueFailedConsent(payload) {
		try {
			const q = JSON.parse(localStorage.getItem('centrix_consent_queue') || '[]');
			q.push(payload);
			if (q.length > 50) q.shift();
			localStorage.setItem('centrix_consent_queue', JSON.stringify(q));
		} catch (e) {}
	}

	function flushConsentQueue() {
		if (!ENABLE_BACKEND_TRACKING) return;
		try {
			const q = JSON.parse(localStorage.getItem('centrix_consent_queue') || '[]');
			if (!q.length) return;
			fetch(API_ENDPOINT + '/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ events: q }),
				keepalive: true, credentials: 'omit'
			}).then(res => {
				if (res.ok) localStorage.removeItem('centrix_consent_queue');
			}).catch(() => {});
		} catch (e) {}
	}

	// ============================================================
	// POPUP 1 — SECURITY WARNING
	// ============================================================
	const SEC_ACK_KEY = 'centrix_security_warning_ack';
	const SEC_VER     = '1.0';

	function secShouldShow() {
		return localStorage.getItem(SEC_ACK_KEY) !== SEC_VER;
	}
	function secMarkAck() {
		localStorage.setItem(SEC_ACK_KEY, SEC_VER);
		trackConsent('security_warning_ack', SEC_VER);
	}

	function buildSecurityModal(onClose) {
		const overlay = document.createElement('div');
		overlay.id = 'centrix-security-overlay';
		overlay.innerHTML = `
			<div class="centrix-security-card">
				<div class="centrix-security-header">
					<div class="centrix-security-icon">!</div>
					<div>
						<div class="centrix-security-badge">Cảnh báo bảo mật</div>
						<h2>Quy định về sử dụng có trách nhiệm</h2>
					</div>
				</div>
				<div class="centrix-security-body">
					<p class="lead">CentriX giám sát hoạt động hệ thống và sẽ chuyển hồ sơ cho cơ quan chức năng nếu phát hiện hành vi tấn công, truy cập trái phép hoặc đánh cắp dữ liệu của khách hàng khác.</p>

					<div class="centrix-security-warning-box">
						<p>Vi phạm có thể bị xử lý hình sự theo <b>Điều 288, 289, 290 Bộ luật Hình sự</b> với mức phạt tù <b>đến 20 năm</b>, và phạt tiền <b>đến 3 tỷ đồng</b> theo Luật BVDLCN số 91/2025/QH15.</p>
					</div>

					<p class="footnote">Báo cáo lỗ hổng có thiện chí: <a href="mailto:support@centrix.im">support@centrix.im</a> · <a href="https://docs.centrix.im/security-policy" target="_blank">Xem chi tiết quy định</a></p>
				</div>
				<div class="centrix-security-footer">
					<label class="centrix-security-check">
						<input type="checkbox" id="centrix-security-confirm">
						<span>Tôi đã đọc, hiểu rõ và cam kết tuân thủ</span>
					</label>
					<button id="centrix-security-ok" class="btn-warn" disabled>Đồng ý và tiếp tục</button>
				</div>
			</div>
		`;

		const cb    = overlay.querySelector('#centrix-security-confirm');
		const okBtn = overlay.querySelector('#centrix-security-ok');
		cb.addEventListener('change', () => { okBtn.disabled = !cb.checked; });

		okBtn.addEventListener('click', () => {
			if (!cb.checked) return;
			secMarkAck();
			overlay.style.animation = 'centrixFadeIn .25s ease reverse';
			setTimeout(() => {
				if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
				if (typeof onClose === 'function') onClose();
			}, 250);
		});

		return overlay;
	}

	// ============================================================
	// POPUP 2 — PRIVACY NOTICE
	// ============================================================
	const NOTICE_LAST_KEY      = 'centrix_notice_last_shown';
	const NOTICE_ACK_KEY       = 'centrix_notice_ack';
	const NOTICE_DISMISSED_KEY = 'centrix_notice_dismissed_ver';
	const NOTICE_VER           = '2.2';
	const COOLDOWN_MS          = 24 * 60 * 60 * 1000;
	const TOS_URL              = 'https://docs.centrix.im/terms-of-sevice';
	const PRIVACY_URL          = 'https://docs.centrix.im/privacy-policy';

	function noticeShouldShow() {
		if (localStorage.getItem(NOTICE_DISMISSED_KEY) === NOTICE_VER) return false;
		const ackVer = localStorage.getItem(NOTICE_ACK_KEY);
		if (ackVer !== NOTICE_VER) return true;
		const last = parseInt(localStorage.getItem(NOTICE_LAST_KEY) || '0', 10);
		return Date.now() - last >= COOLDOWN_MS;
	}
	function noticeMarkAck() {
		localStorage.setItem(NOTICE_ACK_KEY, NOTICE_VER);
		localStorage.setItem(NOTICE_LAST_KEY, String(Date.now()));
		trackConsent('privacy_notice_ack', NOTICE_VER);
	}
	function noticeMarkDismissedForever() {
		localStorage.setItem(NOTICE_DISMISSED_KEY, NOTICE_VER);
		localStorage.setItem(NOTICE_ACK_KEY, NOTICE_VER);
		localStorage.setItem(NOTICE_LAST_KEY, String(Date.now()));
		trackConsent('privacy_notice_dismissed', NOTICE_VER);
	}

	function buildNoticeModal() {
		const overlay = document.createElement('div');
		overlay.id = 'centrix-notice-overlay';
		overlay.innerHTML = `
			<div class="centrix-notice-card">
				<div class="centrix-notice-header">
					<div class="centrix-notice-badge">CAM KẾT QUYỀN RIÊNG TƯ</div>
					<h2>CentriX không bao giờ thấy nội dung của bạn</h2>
				</div>
				<div class="centrix-notice-body">
					<div class="centrix-notice-pledge">
						<div class="pledge-item">
							<div class="pledge-icon">✓</div>
							<div><b>Không đọc nội dung</b> bạn trao đổi với Claude, ChatGPT, Canva, Figma...</div>
						</div>
						<div class="pledge-item">
							<div class="pledge-icon">✓</div>
							<div><b>Không lưu trữ</b> trên server CentriX — dữ liệu đi thẳng giữa trình duyệt và nhà cung cấp</div>
						</div>
						<div class="pledge-item">
							<div class="pledge-icon">✓</div>
							<div><b>Không bán dữ liệu</b> cho bất kỳ bên thứ ba nào</div>
						</div>
					</div>

					<div class="centrix-action-section">
						<p><b>Lưu ý:</b> Vì CentriX không lưu nội dung, hãy chủ động sao lưu các cuộc hội thoại quan trọng bằng <b>CentriX Exporter</b> trên thanh công cụ.</p>
					</div>
				</div>
				<div class="centrix-notice-footer">
					<label class="centrix-notice-optout">
						<input type="checkbox" id="centrix-notice-dontshow">
						<span>Không hiển thị lại</span>
					</label>
					<div class="centrix-notice-footer-row">
						<div class="centrix-notice-links">
							<a href="${TOS_URL}" target="_blank">Điều khoản</a>
							<span>·</span>
							<a href="${PRIVACY_URL}" target="_blank">Bảo mật</a>
							<span>·</span>
							<a href="mailto:support@centrix.im">Liên hệ</a>
						</div>
						<button id="centrix-notice-ok" class="btn-primary">Tôi đã hiểu</button>
					</div>
				</div>
			</div>
		`;

		overlay.querySelector('#centrix-notice-ok').addEventListener('click', () => {
			const dontShow = overlay.querySelector('#centrix-notice-dontshow').checked;
			if (dontShow) noticeMarkDismissedForever();
			else noticeMarkAck();
			overlay.style.animation = 'centrixFadeIn .25s ease reverse';
			setTimeout(() => {
				if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			}, 250);
		});

		return overlay;
	}

	// ============================================================
	// SHARED STYLES
	// ============================================================
	function injectStyles() {
		if (document.getElementById('centrix-popups-style')) return;
		const style = document.createElement('style');
		style.id = 'centrix-popups-style';
		style.textContent = `
			@keyframes centrixFadeIn{from{opacity:0}to{opacity:1}}
			@keyframes centrixSlideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}

			/* SECURITY POPUP — soft amber, không còn chói */
			#centrix-security-overlay{
				position:fixed;inset:0;z-index:2147483647;
				background:rgba(15,23,42,.55);backdrop-filter:blur(4px);
				display:flex;align-items:center;justify-content:center;
				font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;
				animation:centrixFadeIn .25s ease;
			}
			.centrix-security-card{
				background:#fff;border-radius:14px;
				width:min(660px,94vw);max-height:90vh;
				display:flex;flex-direction:column;
				box-shadow:0 20px 50px rgba(0,0,0,.25);
				animation:centrixSlideUp .3s ease;
			}
			.centrix-security-header{
				background:linear-gradient(135deg,#dc2626,#991b1b);
				color:#fff;padding:18px 24px;border-radius:14px 14px 0 0;
				flex-shrink:0;display:flex;align-items:center;gap:14px;
			}
			.centrix-security-icon{
				flex-shrink:0;width:44px;height:44px;border-radius:50%;
				background:rgba(255,255,255,.22);
				display:flex;align-items:center;justify-content:center;
				font-size:24px;font-weight:700;
			}
			.centrix-security-badge{
				display:inline-block;font-size:10px;font-weight:700;
				letter-spacing:1px;padding:3px 8px;border-radius:4px;
				background:rgba(255,255,255,.25);margin-bottom:4px;
				text-transform:uppercase;
			}
			.centrix-security-header h2{margin:0;font-size:17px;font-weight:700;line-height:1.3;}
			.centrix-security-body{
				padding:20px 26px;color:#1f2937;overflow-y:auto;flex:1;
				font-size:13px;line-height:1.65;
			}
			.centrix-security-body .lead{
				font-size:14px;line-height:1.6;color:#374151;margin:0 0 14px;
			}
			.centrix-security-body .footnote{
				font-size:11px;color:#6b7280;margin:14px 0 0;line-height:1.6;
			}
			.centrix-security-body .footnote a{color:#dc2626;font-weight:500;}
			.centrix-security-warning-box{
				background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626;
				padding:12px 16px;border-radius:0 6px 6px 0;margin-bottom:18px;
			}
			.centrix-security-warning-box p{margin:0;color:#7f1d1d;font-size:13px;line-height:1.6;}
			.centrix-security-body section{margin-bottom:18px;}
			.centrix-security-body section:last-child{margin-bottom:0;}
			.centrix-security-body h3{
				font-size:12px;font-weight:700;color:#dc2626;
				margin:0 0 10px;text-transform:uppercase;letter-spacing:.4px;
				border-bottom:1px solid #fecaca;padding-bottom:6px;
			}
			.centrix-security-body p{margin:6px 0;color:#374151;}
			.centrix-security-body a{color:#dc2626;font-weight:600;}
			.prohibited-list{margin:8px 0;padding-left:0;list-style:none;}
			.prohibited-list li{
				padding:8px 12px 8px 30px;margin-bottom:5px;
				background:#fef2f2;border-left:3px solid #dc2626;
				border-radius:0 5px 5px 0;font-size:12px;color:#7f1d1d;
				position:relative;line-height:1.5;
			}
			.prohibited-list li:before{
				content:"•";position:absolute;left:14px;top:8px;
				color:#dc2626;font-weight:700;font-size:14px;
			}
			.prohibited-list li b{color:#991b1b;}
			.penalty-table{
				width:100%;border-collapse:collapse;font-size:12px;margin:8px 0;
				border:1px solid #fecaca;border-radius:6px;overflow:hidden;
			}
			.penalty-table td{padding:9px 12px;border-bottom:1px solid #fee2e2;vertical-align:top;}
			.penalty-table tr:last-child td{border-bottom:none;}
			.penalty-table td:first-child{width:55%;background:#fef2f2;color:#7f1d1d;}
			.penalty-table td:first-child b{color:#991b1b;font-size:12px;}
			.penalty-table td:first-child small{color:#b45353;font-size:11px;display:block;margin-top:2px;font-weight:400;}
			.penalty-table td:last-child{color:#374151;font-size:12px;}
			.penalty-table td:last-child b{color:#dc2626;}
			.action-list{margin:8px 0;padding-left:22px;color:#374151;}
			.action-list li{margin-bottom:5px;font-size:12px;line-height:1.5;}
			.centrix-security-monitoring{
				background:#f8fafc;color:#475569;padding:11px 14px;border-radius:6px;
				font-size:11px;line-height:1.5;margin:14px 0;border:1px solid #e2e8f0;
			}
			.centrix-security-monitoring p{margin:0;color:#475569;}
			.centrix-security-monitoring b{color:#1e293b;}
			.centrix-security-footer{
				padding:18px 26px 22px;border-top:1px solid #e5e7eb;
				background:#fafafa;border-radius:0 0 14px 14px;flex-shrink:0;
			}
			.centrix-security-check{
				display:flex !important;align-items:flex-start;gap:10px;
				font-size:13px;color:#475569;cursor:pointer;
				margin-bottom:14px;line-height:1.5;
				padding:10px 12px;background:#fff;border:1px solid #e2e8f0;
				border-radius:8px;transition:border-color .15s,background .15s;
			}
			.centrix-security-check:hover{
				background:#fafafa;border-color:#cbd5e1;
			}
			.centrix-security-check input{
				width:16px !important;height:16px !important;
				cursor:pointer;flex-shrink:0;margin:1px 0 0 0 !important;accent-color:#dc2626;
			}
			.centrix-security-card .btn-warn{
				display:block !important;width:100% !important;
				padding:13px 22px !important;
				border-radius:8px !important;border:none !important;
				cursor:pointer !important;
				font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif !important;
				font-size:14px !important;font-weight:600 !important;
				background:#dc2626 !important;color:#fff !important;
				box-shadow:0 2px 8px rgba(220,38,38,.25) !important;
				transition:background .15s,box-shadow .15s,transform .1s !important;
				text-align:center !important;line-height:1.4 !important;
				letter-spacing:.2px !important;
				margin:0 !important;
			}
			.centrix-security-card .btn-warn:hover:not(:disabled){
				background:#b91c1c !important;
				box-shadow:0 4px 12px rgba(220,38,38,.35) !important;
				transform:translateY(-1px);
			}
			.centrix-security-card .btn-warn:active:not(:disabled){
				transform:translateY(0);
				box-shadow:0 2px 6px rgba(220,38,38,.25) !important;
			}
			.centrix-security-card .btn-warn:disabled{
				background:#cbd5e1 !important;color:#94a3b8 !important;
				cursor:not-allowed !important;
				box-shadow:none !important;
			}

			/* PRIVACY NOTICE — green */
			#centrix-notice-overlay{
				position:fixed;inset:0;z-index:2147483647;
				background:rgba(15,23,42,.55);backdrop-filter:blur(4px);
				display:flex;align-items:center;justify-content:center;
				font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;
				animation:centrixFadeIn .25s ease;
			}
			.centrix-notice-card{
				background:#fff;border-radius:14px;
				width:min(660px,94vw);max-height:90vh;display:flex;flex-direction:column;
				box-shadow:0 20px 50px rgba(0,0,0,.25);
				animation:centrixSlideUp .3s ease;
			}
			.centrix-notice-header{
				background:linear-gradient(135deg,#10b981,#059669);
				color:#fff;padding:18px 24px;border-radius:14px 14px 0 0;flex-shrink:0;
			}
			.centrix-notice-badge{
				display:inline-block;font-size:10px;font-weight:700;
				letter-spacing:1px;padding:3px 8px;border-radius:4px;
				background:rgba(255,255,255,.25);margin-bottom:6px;
			}
			.centrix-notice-header h2{margin:0;font-size:18px;font-weight:700;line-height:1.3;}
			.centrix-notice-body{padding:18px 24px;color:#1f2937;overflow-y:auto;flex:1;font-size:13px;line-height:1.6;}
			.centrix-notice-pledge{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 16px;margin-bottom:14px;}
			.pledge-item{display:flex;gap:11px;margin-bottom:9px;align-items:flex-start;font-size:13px;color:#065f46;line-height:1.55;}
			.pledge-item:last-child{margin-bottom:0;}
			.pledge-item > div:last-child{flex:1;}
			.pledge-icon{
				flex-shrink:0;width:22px;height:22px;border-radius:50%;
				background:#10b981;color:#fff;font-weight:700;
				display:flex;align-items:center;justify-content:center;font-size:13px;
			}
			.pledge-item b{color:#065f46;font-weight:700;}
			.centrix-notice-body section{margin-bottom:16px;}
			.centrix-notice-body section:last-child{margin-bottom:0;}
			.centrix-notice-body h3{
				font-size:13px;font-weight:700;color:#059669;
				margin:0 0 8px;text-transform:uppercase;letter-spacing:.3px;
			}
			.centrix-notice-body p{margin:6px 0;color:#374151;}
			.centrix-notice-body a{color:#059669;text-decoration:none;font-weight:500;}
			.centrix-notice-body a:hover{text-decoration:underline;}
			.centrix-flow{display:flex;align-items:center;justify-content:center;gap:10px;margin:12px 0 8px;flex-wrap:wrap;}
			.flow-box{
				background:#f0fdf4;border:2px solid #10b981;
				padding:10px 14px;border-radius:8px;
				font-size:12px;font-weight:600;color:#065f46;text-align:center;min-width:80px;
			}
			.flow-box small{font-weight:400;font-size:10px;color:#047857;}
			.flow-centrix{background:#eff6ff;border-color:#3b82f6;color:#1e40af;}
			.flow-centrix small{color:#3b82f6;}
			.flow-saas{background:#fef3c7;border-color:#f59e0b;color:#92400e;}
			.flow-arrow{font-size:20px;color:#059669;font-weight:700;}
			.flow-note{font-size:11px;color:#6b7280;text-align:center;font-style:italic;}
			.centrix-data-table{
				width:100%;border-collapse:collapse;
				background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;
				overflow:hidden;font-size:12px;margin:8px 0;
			}
			.centrix-data-table td{padding:9px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;}
			.centrix-data-table tr:last-child td{border-bottom:none;}
			.centrix-data-table td:first-child{color:#475569;width:140px;background:#f1f5f9;}
			.centrix-data-table td:first-child b{color:#1e293b;font-size:12px;}
			.legal-basis{
				font-size:11px;color:#6b7280;font-style:italic;margin-top:6px;
				padding:8px 10px;background:#f9fafb;border-left:3px solid #cbd5e1;
				border-radius:0 4px 4px 0;
			}
			.centrix-rights{margin:6px 0;padding-left:20px;color:#374151;}
			.centrix-rights li{margin-bottom:3px;font-size:12px;}
			.centrix-action-section{
				background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;
				padding:12px 14px;font-size:12px;line-height:1.6;color:#1e40af;
			}
			.centrix-action-section p{margin:0;color:#1e40af;}
			.centrix-action-section b{color:#1e3a8a;}
			.centrix-bar-demo{
				background:#1f2937;padding:8px 10px;border-radius:8px;
				display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:8px 0 4px;
			}
			.demo-label{font-size:9px;color:#9ca3af;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-right:4px;}
			.demo-btn{background:#0a84ff;color:#fff;font-size:10px;font-weight:600;padding:5px 9px;border-radius:5px;}
			.demo-btn-drive{background:#f59e0b;}
			.centrix-notice-footer{
				padding:16px 24px 20px;border-top:1px solid #e5e7eb;
				background:#f9fafb;border-radius:0 0 14px 14px;flex-shrink:0;
			}
			.centrix-notice-optout{
				display:flex !important;align-items:center;gap:9px;
				font-size:12px;color:#6b7280;cursor:pointer;
				margin-bottom:12px;line-height:1.4;
			}
			.centrix-notice-optout input{
				width:15px !important;height:15px !important;
				cursor:pointer;flex-shrink:0;margin:0 !important;accent-color:#10b981;
			}
			.centrix-notice-footer-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
			.centrix-notice-links{font-size:11px;color:#6b7280;}
			.centrix-notice-links a{color:#059669;font-weight:500;}
			.centrix-notice-links span{margin:0 6px;color:#cbd5e1;}
			.centrix-notice-card .btn-primary{
				display:inline-block !important;
				padding:11px 24px !important;
				border-radius:8px !important;border:none !important;
				cursor:pointer !important;
				font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif !important;
				font-size:13px !important;font-weight:600 !important;
				background:#10b981 !important;color:#fff !important;
				box-shadow:0 2px 8px rgba(16,185,129,.25) !important;
				transition:background .15s,box-shadow .15s,transform .1s !important;
				margin:0 !important;line-height:1.4 !important;
			}
			.centrix-notice-card .btn-primary:hover{
				background:#059669 !important;
				box-shadow:0 4px 12px rgba(16,185,129,.35) !important;
				transform:translateY(-1px);
			}
			.centrix-notice-card .btn-primary:active{
				transform:translateY(0);
				box-shadow:0 2px 6px rgba(16,185,129,.25) !important;
			}

			@media (prefers-color-scheme:dark){
				/* SECURITY POPUP — neutral dark, readable */
				.centrix-security-card{background:#1e293b;}
				.centrix-security-body{color:#e2e8f0;}
				.centrix-security-body p{color:#cbd5e1;}
				.centrix-security-body h3{color:#f87171;border-bottom-color:#475569;}
				.centrix-security-body a{color:#f87171;}
				.centrix-security-warning-box{
					background:#334155;border-color:#475569;border-left-color:#dc2626;
				}
				.centrix-security-warning-box p{color:#fecaca;}
				.prohibited-list li{
					background:#334155;color:#e2e8f0;border-left-color:#dc2626;
				}
				.prohibited-list li b{color:#fecaca;}
				.prohibited-list li:before{color:#f87171;}
				.penalty-table{border-color:#475569;}
				.penalty-table td{border-bottom-color:#334155;}
				.penalty-table td:first-child{background:#334155;color:#e2e8f0;}
				.penalty-table td:first-child b{color:#fecaca;}
				.penalty-table td:first-child small{color:#94a3b8;}
				.penalty-table td:last-child{color:#cbd5e1;background:#1e293b;}
				.penalty-table td:last-child b{color:#f87171;}
				.action-list{color:#cbd5e1;}
				.centrix-security-monitoring{
					background:#0f172a;border-color:#334155;color:#94a3b8;
				}
				.centrix-security-monitoring p{color:#94a3b8;}
				.centrix-security-monitoring b{color:#e2e8f0;}
				.centrix-security-footer{background:#0f172a;border-top-color:#334155;}
				.centrix-security-check{
					color:#cbd5e1;background:#1e293b;border-color:#334155;
				}
				.centrix-security-check:hover{
					background:#334155;border-color:#475569;
				}

				/* PRIVACY NOTICE — neutral dark */
				.centrix-notice-card{background:#1e293b;}
				.centrix-notice-body{color:#e2e8f0;}
				.centrix-notice-body p{color:#cbd5e1;}
				.centrix-notice-body h3{color:#34d399;}
				.centrix-notice-body a{color:#34d399;}
				.centrix-notice-pledge{background:#334155;border-color:#475569;}
				.pledge-item{color:#f1f5f9;}
				.pledge-item b{color:#fff;}
				.flow-box{background:#334155;color:#a7f3d0;border-color:#10b981;}
				.flow-centrix{background:#1e3a8a;color:#bfdbfe;border-color:#3b82f6;}
				.flow-centrix small{color:#93c5fd;}
				.flow-saas{background:#334155;color:#fcd34d;border-color:#f59e0b;}
				.flow-note{color:#94a3b8;}
				.centrix-data-table{background:#1e293b;border-color:#475569;}
				.centrix-data-table td{border-bottom-color:#334155;color:#cbd5e1;}
				.centrix-data-table td:first-child{background:#334155;color:#e2e8f0;}
				.centrix-data-table td:first-child b{color:#f1f5f9;}
				.legal-basis{background:#0f172a;color:#94a3b8;border-left-color:#475569;}
				.centrix-rights{color:#cbd5e1;}
				.centrix-action-section{background:#334155;border-color:#475569;}
				.centrix-action-section h3{color:#bfdbfe;}
				.centrix-action-section p{color:#f1f5f9;}
				.centrix-action-section b{color:#fff;}
				.centrix-notice-footer{background:#0f172a;border-top-color:#334155;}
				.centrix-notice-optout{color:#94a3b8;}
				.centrix-notice-links{color:#94a3b8;}
				.centrix-notice-links span{color:#475569;}
			}
		`;
		document.head.appendChild(style);
	}

	// ============================================================
	// ORCHESTRATOR
	// ============================================================
	function showNoticePopup() {
		if (!noticeShouldShow()) return;
		// Đảm bảo security đã đóng hoàn toàn
		if (document.getElementById('centrix-security-overlay')) {
			console.log('[CentriX] security still open, defer notice');
			return;
		}
		if (document.getElementById('centrix-notice-overlay')) return;
		document.body.appendChild(buildNoticeModal());
	}

	function showSecurityPopup() {
		if (document.getElementById('centrix-security-overlay')) return;
		document.body.appendChild(buildSecurityModal(showNoticePopup));
	}

	function init() {
		console.log('[CentriX] init() called');
		console.log('[CentriX] document.body exists:', !!document.body);
		console.log('[CentriX] localStorage flags:', {
			security: localStorage.getItem(SEC_ACK_KEY),
			notice_ack: localStorage.getItem(NOTICE_ACK_KEY),
			notice_dismissed: localStorage.getItem(NOTICE_DISMISSED_KEY),
			notice_last: localStorage.getItem(NOTICE_LAST_KEY),
		});
		injectStyles();
		if (!document.body) {
			console.warn('[CentriX] document.body chưa sẵn sàng, retry sau 200ms');
			setTimeout(init, 200);
			return;
		}
		flushConsentQueue();
		const secNeed    = secShouldShow();
		const noticeNeed = noticeShouldShow();
		console.log('[CentriX] secShouldShow:', secNeed, '| noticeShouldShow:', noticeNeed);
		if (secNeed) {
			console.log('[CentriX] showing security popup');
			showSecurityPopup();
		} else if (noticeNeed) {
			console.log('[CentriX] showing notice popup');
			showNoticePopup();
		} else {
			console.log('[CentriX] không cần show popup nào (đã ack hoặc trong cooldown)');
		}
	}

	// Multiple init triggers để chắc chắn chạy được
	function scheduleInit() {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => setTimeout(init, 600), { once: true });
		} else {
			setTimeout(init, 600);
		}
		// Backup: đảm bảo chạy khi window load (fallback nếu DOMContentLoaded không fire)
		window.addEventListener('load', () => {
			if (!document.getElementById('centrix-security-overlay') &&
				!document.getElementById('centrix-notice-overlay')) {
				setTimeout(init, 300);
			}
		}, { once: true });
	}
	scheduleInit();

	// Debug helpers (chạy trong isolated world — xem centrix-debug-main.js cho main world)
	window.centrixShowSecurityWarning = function () {
		localStorage.removeItem(SEC_ACK_KEY);
		injectStyles();
		showSecurityPopup();
	};
	window.centrixShowNotice = function () {
		localStorage.removeItem(NOTICE_LAST_KEY);
		localStorage.removeItem(NOTICE_ACK_KEY);
		localStorage.removeItem(NOTICE_DISMISSED_KEY);
		injectStyles();
		showNoticePopup();
	};
	window.centrixShowAllPopups = function () {
		localStorage.removeItem(SEC_ACK_KEY);
		localStorage.removeItem(NOTICE_LAST_KEY);
		localStorage.removeItem(NOTICE_ACK_KEY);
		localStorage.removeItem(NOTICE_DISMISSED_KEY);
		injectStyles();
		showSecurityPopup();
	};
	window.centrixGetDeviceId = function () {
		return getDeviceId();
	};

	console.log('[CentriX Popups Loader v1.2] loaded — soft amber + tracking + double-load guard');
})();
