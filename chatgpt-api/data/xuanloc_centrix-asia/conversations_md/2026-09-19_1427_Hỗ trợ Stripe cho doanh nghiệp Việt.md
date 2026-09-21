# Hỗ trợ Stripe cho doanh nghiệp Việt Nam

> **Model:** `gpt-5-6-thinking` · **Created:** 2026-09-19 14:27:03 · **Updated:** 2026-09-19 14:28:55
> **ID:** `6aae3945-c8e4-83ec-8bc7-f946e21e7a33`

---

### 👤 User · 2026-09-19 14:27:02

doanh nghiệp việt nam muốn hõ trợ thanh toán từ stripe thì sao

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-19 14:27:08

Anh đang hỏi theo hướng **doanh nghiệp Việt Nam muốn nhận thanh toán online bằng Stripe** đúng không? Em kiểm tra tình trạng hỗ trợ hiện tại của Stripe tại Việt Nam và các phương án triển khai hợp lệ để anh chọn cách phù hợp.

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-19 14:27:24

Có anh. Nhưng **tính đến ngày 19/09/2026, Stripe vẫn chưa liệt kê Việt Nam là quốc gia được hỗ trợ trực tiếp để doanh nghiệp Việt Nam mở Stripe Payments**. Vì vậy, nếu Công ty Việt Nam đứng tên pháp nhân Việt Nam thì chưa thể đơn giản chọn “Vietnam”, nhập MST Việt Nam và nhận tiền Stripe như doanh nghiệp Mỹ/Singapore. ([Stripe](https://stripe.com/global?utm_source=chatgpt.com)) 

Nếu mục tiêu của anh là cho **CentriX/CetriX nhận thanh toán quốc tế bằng Visa/Mastercard, subscription hàng tháng qua Stripe**, có 3 hướng:

1. **Lập pháp nhân ở quốc gia Stripe hỗ trợ** — ví dụ Mỹ hoặc Singapore. Đây là phương án phù hợp nếu anh định kinh doanh SaaS quốc tế lâu dài. Stripe yêu cầu pháp nhân, mã số thuế, thông tin doanh nghiệp, website và tài khoản ngân hàng phù hợp với quốc gia đăng ký; Stripe cũng thực hiện KYC và có thể yêu cầu xác minh địa chỉ/doanh nghiệp. ([Hỗ trợ Stripe](https://support.stripe.com/questions/requirements-to-open-a-stripe-account-in-another-country?locale=en-GB&utm_source=chatgpt.com)) 

2. **Stripe Atlas → thành lập công ty Mỹ.** Stripe cho phép founder ở hơn 175 quốc gia thành lập Delaware LLC hoặc C Corporation. Hiện Stripe công bố phí Atlas là **500 USD một lần**, gồm phí thành lập và registered agent năm đầu; từ năm sau registered agent là **100 USD/năm**. Sau khi thành lập, doanh nghiệp có thể thiết lập hệ thống ngân hàng/thanh toán Stripe cho công ty Mỹ. ([Stripe](https://stripe.com/atlas?utm_source=chatgpt.com)) 

3. Nếu anh **không muốn lập thêm pháp nhân nước ngoài**, có thể dùng một cổng thanh toán/Merchant of Record hỗ trợ doanh nghiệp Việt Nam, thay vì Stripe trực tiếp. Với SaaS/AI subscription, mô hình Merchant of Record còn có ưu điểm là bên đó đứng ra xử lý payment, VAT/sales tax ở nhiều thị trường và chargeback; đổi lại phí thường cao hơn Stripe.

Với mô hình CentriX, nếu anh đi theo Stripe, luồng em khuyên là:

**Khách hàng → `cetrix.app` → Stripe Checkout → Visa/Mastercard/Apple Pay... → Stripe → tài khoản công ty nước ngoài**

Sau khi Stripe báo webhook `checkout.session.completed` hoặc `invoice.paid`:

**CetriX backend → kích hoạt gói → cộng USD Credit → phát hành hóa đơn/receipt → lưu transaction ID.**

Ví dụ khách mua:

> **CetriX AI – $10/month** 
> Thanh toán qua Stripe 
> → Stripe thu $10 
> → webhook về server CetriX 
> → tài khoản khách tự động nhận 70 USD Credit 
> → tháng sau Stripe tự động gia hạn.

Điểm quan trọng là **không nên mua/thuê Stripe account, dùng địa chỉ giả hoặc mượn Stripe của người khác**. Stripe xác minh legal entity, website, bank account và địa chỉ; khi không xác minh được họ có thể tạm dừng processing/payout. ([Hỗ trợ Stripe](https://support.stripe.com/questions/verifying-your-business-address?utm_source=chatgpt.com)) 

Nếu anh muốn dùng **pháp nhân CentriX Việt Nam hiện tại nhưng mở thêm một công ty Mỹ chỉ để xử lý Stripe**, mô hình nên thiết kế rõ ai là bên bán cho khách và dòng tiền giữa công ty Mỹ ↔ công ty Việt Nam, vì nó liên quan kế toán, thuế và hợp đồng nội bộ.

**Nếu mục tiêu của anh là bán CetriX ra quốc tế**, em nghiêng về cấu trúc:

**CentriX Việt Nam** 
↓ sở hữu/vận hành sản phẩm 
**CentriX US LLC/C Corp** 
↓ 
**Stripe US** 
↓ 
Khách hàng toàn cầu

Sau đó mới thiết kế dòng tiền từ công ty Mỹ về công ty Việt Nam theo hợp đồng dịch vụ/IP phù hợp, thay vì chuyển tiền cá nhân.

Nếu anh muốn, em có thể làm tiếp cho anh **một sơ đồ hoàn chỉnh “CentriX Việt Nam → Công ty Mỹ → Stripe → Bank → chuyển tiền về Việt Nam”, kèm chi phí thành lập, thuế và quy trình tích hợp Stripe Subscription/API**.

---

### 👤 User · 2026-09-19 14:28:18

Dùng pháp nhân tại Sing sẽ mất bao nhiêu tiền

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-19 14:28:22

Nếu anh mở **pháp nhân Singapore chỉ để dùng Stripe**, chi phí không chỉ có phí thành lập mà còn có **resident director, company secretary, địa chỉ đăng ký và duy trì hằng năm**. Em tách rõ phí nhà nước và phí dịch vụ để anh dễ tính tổng.

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-19 14:28:43

Nếu anh ở Việt Nam và mở **Singapore Pte. Ltd. để dùng Stripe**, thì chi phí thực tế thường cao hơn khá nhiều so với nhìn vào phí đăng ký công ty.

Vì anh không cư trú tại Singapore, ACRA yêu cầu công ty phải có ít nhất **1 director cư trú tại Singapore** và người nước ngoài phải thông qua Corporate Service Provider (CSP) để thành lập. ([Cơ Quan Quản Lý Kế Toán và Doanh Nghiệp](https://www.acra.gov.sg/register/business/requirements-eligibility/?utm_source=chatgpt.com)) 

### Chi phí thực tế

| Khoản | Ước tính |
|---|---:|
| Đăng ký tên ACRA | S$15 |
| Thành lập công ty ACRA | S$300 |
| Company Secretary | ~S$300–1.500/năm |
| Địa chỉ Singapore | ~S$200–800/năm |
| **Nominee Director** | **~S$2.000–5.000/năm** |
| Annual Return ACRA | S$60/năm |
| Kế toán + khai thuế | ~S$700–2.500+/năm |
| **Tổng thực tế năm đầu** | **khoảng S$3.000–6.000** |

Phí chính thức để đăng ký công ty chỉ là **S$315**, nhưng khoản làm đội chi phí đối với founder Việt Nam chính là resident/nominee director. ([Cơ Quan Quản Lý Kế Toán và Doanh Nghiệp](https://www.acra.gov.sg/manage/companies/service-transaction-fees/?utm_source=chatgpt.com)) 

Ví dụ hiện tại Sleek có gói dành cho founder nước ngoài khoảng **S$4.000/năm**, đã gồm thành lập công ty, **12 tháng nominee director**, secretary, registered office, accounting và corporate tax filing. ([Sleek](https://sleek.com/sg/incorporation/foreigner/?utm_source=chatgpt.com)) 

Theo tỷ giá hiện tại khoảng **1 SGD ≈ 20.400đ**:

- **S$3.000 ≈ 61 triệu**
- **S$4.000 ≈ 81–82 triệu**
- **S$5.000 ≈ 102 triệu**
- **S$6.000 ≈ 122 triệu**



### Với trường hợp của anh

Nếu mục đích của anh đơn giản là:

**CetriX → Stripe → nhận Visa/Mastercard → rút tiền**

thì em sẽ dự trù khoảng:

> **Năm đầu: ~80–100 triệu đồng** 
> **Từ năm thứ 2: ~70–100+ triệu đồng/năm**

nếu anh tiếp tục điều hành hoàn toàn từ Việt Nam và vẫn phải thuê nominee director.

Singapore hiện nằm trong danh sách quốc gia Stripe hỗ trợ. Tuy nhiên, có công ty Singapore **không đồng nghĩa Stripe tự động duyệt**; Stripe vẫn xác minh pháp nhân, representative, beneficial owner và thông tin doanh nghiệp. ([Stripe](https://stripe.com/global?utm_source=chatgpt.com)) 

**Nếu anh chỉ lập công ty nước ngoài để lấy Stripe cho CetriX**, thì Singapore có một nhược điểm khá lớn là **phí nominee director hằng năm**. Vì vậy về chi phí thuần túy, em sẽ cân nhắc **Singapore vs US LLC/C-Corp** trước khi mở. Với doanh thu CetriX hiện tại, chênh lệch chi phí duy trì có thể khá đáng kể.

---


*6 messages · 26 nodes*
