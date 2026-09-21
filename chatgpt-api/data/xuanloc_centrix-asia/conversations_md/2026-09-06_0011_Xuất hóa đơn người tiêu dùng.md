# Xuất hóa đơn người tiêu dùng

> **Model:** `gpt-5-6-thinking` · **Created:** 2026-09-06 00:11:07 · **Updated:** 2026-09-06 00:11:37
> **ID:** `6a9c4d28-a5d4-83ec-9427-113d37a6e271`

<style>
blockquote {
  background-color: rgba(59, 130, 246, 0.08) !important;
  border-left: 4px solid #3b82f6 !important;
  padding: 12px 18px !important;
  border-radius: 8px !important;
  margin: 16px 0 !important;
  color: inherit !important;
}
blockquote h3 {
  margin-top: 0 !important;
  color: #60a5fa !important;
}
</style>

---

> ### 👤 User · 2026-09-06 00:11:03
>
> # Người mua KHÔNG cung cấp thông tin thì xuất hoá đơn 'Bán cho người tiêu dùng' theo Nghị định 254 từ 1/7/2026 ra sao?

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-06 00:11:10

Mình sẽ kiểm tra đúng văn bản “Nghị định 254”, thời điểm áp dụng từ **01/07/2026** và cách ghi hóa đơn khi người mua không cung cấp thông tin, để tránh nhầm giữa quy định mới và quy định cũ.

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-06 00:11:24

Đúng anh. Từ **01/07/2026**, Nghị định **254/2026/NĐ-CP** có hiệu lực và thay đổi khá rõ cách xuất hóa đơn cho khách hàng cá nhân/khách lẻ. ([Văn Bản Chính Phủ](https://vanban.chinhphu.vn/?classid=1&docid=218689&orggroupid=2&pageid=27160&utm_source=chatgpt.com)) 

### Trường hợp khách KHÔNG cung cấp đủ thông tin

Theo **điểm b mục 4 Phụ lục về nội dung hóa đơn** của Nghị định 254/2026/NĐ-CP:

Nếu người mua là người tiêu dùng **không cung cấp đủ tên, địa chỉ và số định danh cá nhân**, trên hóa đơn phải thể hiện rõ:

> **“Bán cho người tiêu dùng”**

Cơ quan Thuế đã có hướng dẫn thực tế: kể cả trường hợp khách chỉ cung cấp tên + địa chỉ nhưng **không cung cấp số định danh cá nhân**, thì vẫn xử lý theo hướng ghi **“Bán cho người tiêu dùng”**. ([chinhsachonline.chinhphu.vn](https://chinhsachonline.chinhphu.vn/khach-hang-khong-cung-cap-du-thong-tin-hoa-don-ghi-the-nao-89960.htm)) 

Với hệ thống hóa đơn của CentriX, anh có thể thiết kế cách nhập đơn giản như sau:

| Trường | Nội dung |
|---|---|
| Tên người mua | **Bán cho người tiêu dùng** |
| Địa chỉ | Để trống |
| MST | Để trống |
| Số định danh cá nhân | Để trống |
| Tên hàng hóa/dịch vụ | Ghi dịch vụ thực tế |
| Thành tiền, VAT | Ghi bình thường |

Ví dụ khách mua dịch vụ CentriX 130.000đ nhưng không cung cấp thông tin:

**Người mua:** Bán cho người tiêu dùng 
**Tên dịch vụ:** Dịch vụ cung cấp quyền sử dụng phần mềm/AI theo gói 
**Số lượng:** 1 
**Thành tiền:** 130.000đ 
→ Các thông tin người bán, thuế suất, tiền thuế, tổng thanh toán… vẫn lập bình thường theo loại hóa đơn mà doanh nghiệp đang sử dụng. Nghị định vẫn yêu cầu người bán lập hóa đơn điện tử khi bán hàng hóa/cung cấp dịch vụ. ([Xây Dựng Chính Sách](https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-dinh-so-254-2026-nd-cp-ve-hoa-don-dien-tu-chung-tu-dien-tu-119260713164251972.htm)) 

### Nếu khách cung cấp đầy đủ thông tin

Đối với **cá nhân**, nếu họ muốn thông tin cá nhân xuất hiện trên hóa đơn thì phải thể hiện **tên + địa chỉ + số định danh cá nhân**. Với người nước ngoài, có thể sử dụng hộ chiếu/giấy tờ xuất nhập cảnh và quốc tịch theo quy định. ([chinhsachonline.chinhphu.vn](https://chinhsachonline.chinhphu.vn/khach-hang-khong-cung-cap-du-thong-tin-hoa-don-ghi-the-nao-89960.htm)) 

Đối với **công ty/hộ kinh doanh/cá nhân kinh doanh có MST**, không nên xuất kiểu “Bán cho người tiêu dùng”. Phải lấy thông tin doanh nghiệp/hộ kinh doanh và lập hóa đơn theo thông tin đăng ký tương ứng.

### Điểm rất quan trọng

Hóa đơn ghi **“Bán cho người tiêu dùng”** hoặc hóa đơn không có thông tin người mua **không có giá trị để doanh nghiệp, tổ chức, hộ kinh doanh hoặc cá nhân kinh doanh dùng để hạch toán chi phí hoặc quyết toán thuế**. Đây là quy định được nêu trực tiếp trong Phụ lục của Nghị định. ([chinhsachonline.chinhphu.vn](https://chinhsachonline.chinhphu.vn/khach-hang-khong-cung-cap-du-thong-tin-hoa-don-ghi-the-nao-89960.htm)) 

Vì vậy với CentriX, em khuyên quy trình bán hàng nên chia ngay thành 2 lựa chọn:

**1. Khách cá nhân không cần hóa đơn thông tin →** tự động xuất 
**Người mua: Bán cho người tiêu dùng**

**2. Khách cần hóa đơn để công ty hạch toán →** bắt buộc nhập trước khi xuất:
**Tên công ty + MST + địa chỉ**.

Như vậy anh cũng nên **bỏ cách ghi cũ kiểu “Khách lẻ”, “Người mua không lấy hóa đơn”, “Người mua không cung cấp thông tin”** và chuẩn hóa thành đúng cụm từ của Nghị định:

**“Bán cho người tiêu dùng”.**

Nếu anh muốn, em có thể viết luôn cho anh **quy trình xuất hóa đơn CentriX từ 01/07/2026**, gồm trường hợp khách cá nhân, doanh nghiệp, khách không cung cấp thông tin, hoàn tiền và khách yêu cầu đổi thông tin hóa đơn sau khi đã xuất.

---


*3 messages · 15 nodes*
