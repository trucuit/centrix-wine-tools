# Cấu hình PC thành VPS Public

> **Model:** `gpt-5-6-thinking` · **Created:** 2026-09-16 15:45:19 · **Updated:** 2026-09-19 10:36:28
> **ID:** `6aaa5719-3460-83ec-a1ff-db9169daf426`

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

> ### 👤 User · 2026-09-16 15:46:09
>
> Bạn cho mình hỏi là mình đã mua gói FPT wifi doanh nghiệp mua đủ IP Front
> 118.69.78.15
> IP Route
> 118.69.40.112/30 
>
> thì làm sao để mình biến 1 PC thành VPS ip public

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:46:23

Được anh. Với gói FPT có **IP Front + IP Route /30**, anh hoàn toàn có thể biến một PC Ubuntu/Windows thành máy chủ truy cập từ Internet như VPS. Điểm quan trọng là cấu hình đúng modem/router và firewall; em sẽ tách rõ cách dễ nhất và cách “public IP trực tiếp”.

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:46:32

Được anh. Với cấu hình FPT của anh:

- **IP Front:** `118.69.78.15`
- **IP Route:** `118.69.40.112/30`

thì anh có thể biến một PC vật lý thành một máy chủ có **IP Public trực tiếp**, hoạt động gần như một VPS đặt tại nhà/văn phòng. FPT mô tả IP Front là IP tĩnh phía modem/WAN và IP Route là dải IP bổ sung dùng phía sau; IP Route yêu cầu có IP Front. ([fpttelecom.net.vn](https://fpttelecom.net.vn/san-pham-dich-vu/internet-fpt/cap-quang-doanh-nghiep?utm_source=chatgpt.com)) 

### Dải IP Route của anh

`118.69.40.112/30` có 4 địa chỉ:

| Địa chỉ | Mục đích |
|---|---|
| `118.69.40.112` | Network Address |
| `118.69.40.113` | Usable |
| `118.69.40.114` | Usable |
| `118.69.40.115` | Broadcast |

Có **2 IP usable: `.113` và `.114`**.

Cách triển khai đẹp nhất là:

```text
 INTERNET
 │
 │
 FPT Telecom
 │
 IP Front / WAN
 118.69.78.15
 │
 Router/Firewall
 WAN: 118.69.78.15
 │
 Public LAN /30
 │
 ┌─────────────┴─────────────┐
 │ │
 Router: 118.69.40.113 PC Server: 118.69.40.114
 │
 Ubuntu
 Docker
 Web/API
 SSH...
```

Tức là em khuyên:

```text
Router:
118.69.40.113/30

PC Server:
IP: 118.69.40.114
Subnet: 255.255.255.252 (/30)
Gateway: 118.69.40.113
DNS: 1.1.1.1
 8.8.8.8
```

Trong mô hình này **không NAT IP `118.69.40.114`**. Router chỉ làm nhiệm vụ route + firewall. Máy PC sẽ thực sự nhìn ra Internet bằng:

```text
118.69.40.114
```

và từ bên ngoài anh có thể SSH:

```bash
ssh username@118.69.40.114
```

hoặc chạy website:

```text
https://118.69.40.114
```

sau đó trỏ domain:

```text
server.centrix.digital
 ↓
118.69.40.114
```

### Nhưng có một điểm rất quan trọng

FPT phải đang cấu hình dải:

```text
118.69.40.112/30
```

**route về IP Front `118.69.78.15`**.

Đây chính là mục đích của IP Route. Tuy nhiên cách cấu hình phía modem FPT còn tùy thiết bị FPT cấp. Có modem cho phép cấu hình routed subnet trực tiếp, có trường hợp nên để modem Bridge và dùng router riêng phía sau.

Nếu anh đang dùng modem FPT thông thường thì em **không khuyên cắm PC rồi gán ngay `118.69.40.114`**, vì PC chưa có gateway đúng cho subnet Route này.

### Nếu chưa có router chuyên dụng

Anh có thể dùng chính một máy tính khác làm router, hoặc mua router MikroTik/OpenWrt/pfSense/OPNsense.

Ví dụ rất hợp với hệ thống server của anh:

```text
FPT ONT
 │
 │
MikroTik
 ├── LAN nội bộ: 192.168.2.0/24
 │
 └── Public Server Network
 │
 ├── 118.69.40.113 Router
 │
 └── 118.69.40.114 Ubuntu Server
```

Cách này anh có thể vừa giữ mạng LAN bình thường, vừa có PC server Public IP riêng.

---

Nếu PC Ubuntu anh đang nói chính là máy trước đó đang có:

```text
192.168.2.159
```

thì **chưa cần đổi Ubuntu vội**. Em có thể hướng dẫn anh cấu hình từ đầu theo đúng mạng hiện tại:

**FPT modem → router → Ubuntu `192.168.2.159` → chuyển Ubuntu thành `118.69.40.114` public trực tiếp**, bao gồm cả Netplan và firewall.

Anh chỉ cần gửi cho em **model modem/router FPT đang dùng hoặc ảnh trang cấu hình modem**, em sẽ chỉ chính xác từng mục phải điền.

---

> ### 👤 User · 2026-09-16 15:47:07
>
> Vậy máy tính nó tự có IP khác thì xữ lý sao

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:47:14

Đó là bình thường anh. Máy tính đang cắm vào mạng LAN nên modem/router sẽ tự cấp cho nó một IP nội bộ qua DHCP, ví dụ:

```text
192.168.2.159
```

Trong khi `118.69.40.114` là IP Public anh muốn dành cho server.

Anh có 2 cách xử lý:

### Cách 1 — Gán IP Public trực tiếp cho PC
Nếu router của anh đã cấu hình:

```text
Router Public LAN: 118.69.40.113/30
```

thì trên PC/server anh **tắt DHCP** và đặt IP tĩnh:

```text
IP Address: 118.69.40.114
Subnet: 255.255.255.252
Gateway: 118.69.40.113
DNS: 1.1.1.1
 8.8.8.8
```

Khi đó PC sẽ không còn nhận:

```text
192.168.2.159
```

mà dùng trực tiếp:

```text
118.69.40.114
```

Mô hình:

```text
Internet
 │
FPT
 │
Router
118.69.40.113
 │
 └── Ubuntu Server
 118.69.40.114
```

Đây là kiểu gần giống **VPS thật nhất**.

### Cách 2 — Giữ IP nội bộ cho PC
PC vẫn để:

```text
192.168.2.159
```

sau đó router ánh xạ:

```text
118.69.40.114
 ↓
192.168.2.159
```

bằng **1:1 NAT**.

Ví dụ:

```text
Internet
 │
118.69.40.114
 │
Router
 │
1:1 NAT
 │
192.168.2.159
Ubuntu Server
```

Như vậy bên ngoài truy cập:

```text
118.69.40.114:22
```

router sẽ chuyển vào:

```text
192.168.2.159:22
```

Cách này thường **dễ quản lý và an toàn hơn** vì PC vẫn nằm trong LAN.

### Trường hợp máy có cả Wi-Fi và LAN

Ví dụ:

```text
Wi-Fi: 192.168.1.100
LAN: 118.69.40.114
```

thì vẫn được, nhưng phải cấu hình route cẩn thận để không có **2 default gateway** gây mất mạng.

Với máy Ubuntu server anh đang dùng trước đó có IP:

```text
192.168.2.159
```

em nghiêng về phương án **giữ `192.168.2.159` rồi ánh xạ `118.69.40.114 → 192.168.2.159` trước**. Dễ thử và nếu cấu hình sai cũng ít nguy cơ mất kết nối SSH.

Nếu mục tiêu của anh là **mỗi PC có một IP Public giống VPS**, thì em sẽ hướng dẫn theo **Cách 1**. Nếu chỉ cần **truy cập server từ Internet**, thì **Cách 2** đơn giản hơn.

---

> ### 👤 User · 2026-09-16 15:49:15
>
> 118.69.40.112/30 
>
> 112 mà

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:49:23

Đúng anh, **`118.69.40.112/30` là cả một dải mạng**, không phải IP `112` để gán cho máy tính.

Với subnet `/30`:

| IP | Vai trò |
|---|---|
| `118.69.40.112` | **Network Address** — không gán cho PC |
| `118.69.40.113` | **IP dùng được** |
| `118.69.40.114` | **IP dùng được** |
| `118.69.40.115` | **Broadcast** — không gán cho PC |

Nên khi FPT ghi:

```text
IP Route: 118.69.40.112/30
```

thì họ đang cấp cho anh **dải từ `.112` đến `.115`**, trong đó thực tế có **2 IP usable là `.113` và `.114`**.

Còn:

```text
IP Front: 118.69.78.15
```

là IP WAN/đầu ngoài của đường truyền.

Một điểm em cần đính chính câu trước: **chưa thể khẳng định gateway của PC là `118.69.40.113`** nếu chưa biết FPT đang route subnet này theo kiểu nào. `118.69.40.113` chỉ là ví dụ cấu hình khi router của anh dùng `.113` làm gateway cho `.114`.

Nếu anh gửi em **ảnh thông tin FPT cấp IP Front + IP Route** hoặc **model modem FPT đang dùng**, em có thể chỉ chính xác cách để lấy `118.69.40.114` gán cho PC thành server public mà không làm mất mạng.

---

> ### 👤 User · 2026-09-16 15:49:47
>
> gán được cho bao nhiêu máy

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:49:55

Với dải **`118.69.40.112/30`**, về chuẩn IPv4 có **2 địa chỉ usable**:

- `118.69.40.113`
- `118.69.40.114`

Nhưng số máy gán trực tiếp thường phụ thuộc cách FPT cấu hình:

- Nếu `118.69.40.113` dùng làm **gateway trên router** → còn **1 IP Public (`.114`) cho 1 máy**.
- Nếu FPT route toàn bộ `/30` về `IP Front 118.69.78.15` và router hỗ trợ **routed subnet / 1:1 NAT**, có thể tận dụng **cả `.113` và `.114` cho 2 máy/dịch vụ**, tùy cấu hình router.

Nếu anh muốn kiểu:

```text
PC 1 → 118.69.40.113
PC 2 → 118.69.40.114
```

thì về mặt kỹ thuật **có thể triển khai trong một số cấu hình**, nhưng em cần biết **router/modem FPT đang dùng model nào** để xác định có làm được đúng như vậy hay không.

Nếu anh muốn khoảng **5–6 PC mỗi máy một Public IP riêng**, nên xin FPT dải **/29** thay vì /30.

---

> ### 👤 User · 2026-09-16 15:50:19
>
> Sao bên đó nói 4 Route mà

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:50:26

Đúng anh — bên FPT nói **“4 Route”** thường là họ đang nói **một block có 4 địa chỉ IPv4**, vì `/30` có tổng cộng đúng 4 IP:

| IP | Theo chuẩn subnet /30 |
|---|---|
| `118.69.40.112` | Network |
| `118.69.40.113` | Usable |
| `118.69.40.114` | Usable |
| `118.69.40.115` | Broadcast |

Nên **4 IP Route ≠ 4 IP gán cho 4 máy** trong cách subnet truyền thống. Thông thường chỉ có **2 IP host usable**.

Ngoài ra anh còn có:

```text
IP Front: 118.69.78.15
```

nên FPT có thể diễn đạt là:

```text
1 IP Front
+
4 IP Route (/30)
```

tức là họ cấp **1 IP WAN + một block route gồm 4 địa chỉ**, chứ không nhất thiết là **4 máy dùng được 4 IP public riêng**.

Tuy nhiên có một trường hợp khác: một số ISP route nguyên block về router và dùng cơ chế riêng như **routed /32 / proxy ARP**, khi đó họ *có thể* cho sử dụng nhiều hơn cách subnet /30 truyền thống. Vì vậy nếu nhân viên FPT nói rõ **“4 IP Route dùng được cho 4 thiết bị”**, thì anh nên hỏi họ đúng một câu:

> “Dải `118.69.40.112/30` này bên anh cấp 4 IP public usable hay 4 địa chỉ tổng cộng? IP `.112` và `.115` có được gán trực tiếp cho server không?”

Nếu họ trả lời **`.112` và `.115` cũng dùng được**, thì đây không phải cách `/30` truyền thống và cần cấu hình theo mô hình routing riêng của FPT.

---

> ### 👤 User · 2026-09-16 15:51:03
>
> Vậy mình setup cho PC như nào

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:51:12

Anh setup được, nhưng em khuyên làm theo **phương án an toàn trước để không mất SSH/mất mạng**: giữ IP LAN hiện tại của PC, cấu hình router nhận dải Public Route, rồi mới đưa một IP public vào PC. Em kiểm tra lại cách FPT đang dùng “IP Front + IP Route /30” để tránh gán sai gateway.

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:51:21

Em tìm ra chỗ quan trọng rồi anh: FPT thực sự bán gói **“04 IP Route”**. Trường hợp này khác subnet LAN `/30` thông thường — dải `/30` được **route qua IP Front**, nên 4 địa chỉ Route có thể được ISP cấp để anh sử dụng như các IP public riêng, thay vì bắt buộc mất `.112` và `.115` làm network/broadcast. 

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:51:35

Đúng mô hình của anh thì **không cần đổi PC từ `192.168.2.159` sang `118.69.40.xxx` ngay**. Với gói FPT **IP Front + 04 IP Route**, cách em khuyên là để router quản lý 4 IP Route và ánh xạ từng IP Public vào từng PC.

FPT hiện công bố đúng loại dịch vụ **“IP Front + 04 IP Route”**, nên việc họ gọi dải `/30` này là 4 IP Route là có cơ sở. ([fpttelecom.net.vn](https://fpttelecom.net.vn/san-pham-dich-vu/internet-fpt/cap-quang-doanh-nghiep?utm_source=chatgpt.com)) 

### Với PC Ubuntu hiện tại của anh

Anh đang có:

```text
PC Ubuntu
IP: 192.168.2.159
Gateway: 192.168.2.1
Card: eno2np1
```

**Cứ giữ nguyên như vậy.**

Mô hình sẽ là:

```text
 INTERNET
 │
 FPT Telecom
 │
 IP Front: 118.69.78.15
 │
 ROUTER
 │
 ┌─────────────┴─────────────┐
 │ │
 Public IP Route LAN IP
 118.69.40.112 ─────→ 192.168.2.159
 Ubuntu Server
```

Tức là:

```text
118.69.40.112 ↔ 192.168.2.159
```

Anh truy cập bên ngoài:

```bash
ssh user@118.69.40.112
```

nhưng bản thân Ubuntu vẫn có:

```text
192.168.2.159
```

Đây là cách dễ quản lý nhất.

---

## Nếu anh có 4 PC

Anh có thể bố trí kiểu:

| IP Public FPT | Máy nội bộ |
|---|---|
| `118.69.40.112` | `192.168.2.159` |
| `118.69.40.113` | `192.168.2.160` |
| `118.69.40.114` | `192.168.2.161` |
| `118.69.40.115` | `192.168.2.162` |

Router thực hiện **1:1 NAT**.

Như vậy mỗi PC nhìn từ Internet sẽ giống như một VPS có IP Public riêng.

### Ví dụ trên MikroTik

Nếu router của anh là MikroTik, PC `192.168.2.159` dùng Public `118.69.40.112`:

```bash
/ip firewall nat add chain=dstnat \
dst-address=118.69.40.112 \
action=dst-nat \
to-addresses=192.168.2.159
```

Chiều PC đi ra Internet:

```bash
/ip firewall nat add chain=srcnat \
src-address=192.168.2.159 \
action=src-nat \
to-addresses=118.69.40.112
```

Kết quả:

```text
Internet → 118.69.40.112
 ↓
 Router
 ↓
 192.168.2.159


192.168.2.159 → Internet
 ↓
NAT thành 118.69.40.112
```

### Ubuntu không cần sửa Netplan

File hiện tại của anh có thể giữ:

```yaml
network:
 version: 2
 ethernets:
 eno2np1:
 dhcp4: false
 addresses:
 - 192.168.2.159/24
 routes:
 - to: default
 via: 192.168.2.1
 nameservers:
 addresses:
 - 192.168.2.1
 - 8.8.8.8
```

Điểm cần cấu hình chính nằm ở **router**, không phải Ubuntu.

---

### Nếu anh muốn Public IP nằm thật sự trên card mạng Ubuntu

Cũng làm được:

```text
eno2np1
├── 192.168.2.159/24
└── 118.69.40.112/32
```

rồi router route:

```text
118.69.40.112/32 → 192.168.2.159
```

Đây là **routed public IP**, không NAT. Nó giống VPS hơn nữa, nhưng cấu hình routing/firewall phức tạp hơn và em chưa khuyên làm ở bước đầu.

**Với hệ thống của anh, em chọn 1:1 NAT trước.**

Một lưu ý quan trọng: anh **không nên tự đặt `118.69.40.112/30` vào Ubuntu rồi chọn `.113` làm gateway**. Với “04 IP Route” của FPT, đây là một block được route thông qua đường IP Front; cách xử lý khác với một LAN subnet `/30` truyền thống.

Nếu anh gửi **model router FPT/MikroTik đang dùng hoặc ảnh trang quản trị router**, em có thể chỉ anh chính xác từng mục để cấu hình:

**`118.69.40.112 → PC Ubuntu 192.168.2.159`**, rồi test SSH từ Internet luôn.

---

> ### 👤 User · 2026-09-16 15:52:32
>
>
>
> | IPTheo chuẩn subnet /30 | |
> | ----------------------- | ------------------------------------------------------------ |
> | `118.69.40.112` | Network |
> | `118.69.40.113` | Usable |
> | `118.69.40.114` | Usable |
> | `118.69.40.115` | Broadcast<br><br>4 cái này thì cáo này dùng được thật cho PC |

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:52:47

Đúng anh, **nếu hợp đồng/FPT xác nhận anh được cấp “04 IP Route”**, thì mục đích dịch vụ là cho anh sử dụng **4 địa chỉ IP Route**. Trang FPT cũng ghi rõ các lựa chọn **“IP Front + 04 IP Route”** và bảng giá ghi IP Route số lượng **4**. ([FPT Telecom](https://fpttelecom.net.vn/san-pham-dich-vu/internet-fpt/cap-quang-doanh-nghiep?utm_source=chatgpt.com)) 

Điểm dễ nhầm là `118.69.40.112/30`. Nếu đem `/30` này làm **một mạng LAN Ethernet bình thường**, thì đúng chuẩn chỉ `.113` và `.114` là host usable. Nhưng nếu FPT bán nó dưới dạng **04 IP Route**, thì họ phải **route cả block này qua IP Front** theo cách triển khai của họ; lúc đó anh không nên cấu hình PC kiểu `118.69.40.112/30` trực tiếp như một subnet LAN thông thường.

Với 4 PC, cách hợp lý là:

| IP Public Route | PC nội bộ |
|---|---|
| `118.69.40.112` | PC1 `192.168.2.159` |
| `118.69.40.113` | PC2 `192.168.2.160` |
| `118.69.40.114` | PC3 `192.168.2.161` |
| `118.69.40.115` | PC4 `192.168.2.162` |

Router sẽ làm **1:1 NAT**:

```text
118.69.40.112 ↔ 192.168.2.159
118.69.40.113 ↔ 192.168.2.160
118.69.40.114 ↔ 192.168.2.161
118.69.40.115 ↔ 192.168.2.162
```

Như vậy PC1 vẫn để:

```text
IP: 192.168.2.159
Gateway: 192.168.2.1
```

nhưng từ Internet nó xuất hiện bằng:

```text
118.69.40.112
```

**Đây là cách em khuyên anh triển khai**, chứ không đặt cả 4 PC vào subnet `/30`.

Có một việc anh nên xác nhận với kỹ thuật FPT trước khi cấu hình: **“4 IP `118.69.40.112–115` đều là IP Route usable phải không, và block này đã được route về IP Front `118.69.78.15` chưa?”**

Nếu họ trả lời **đúng**, thì anh có thể dùng đủ **4 IP cho 4 PC/server**. FPT công khai gói “04 IP Route”, nhưng trang công khai em tìm được chưa mô tả chi tiết cơ chế routing/gateway của block nên phần đó cần FPT xác nhận theo đường truyền cụ thể của anh. ([FPT Telecom](https://fpttelecom.net.vn/san-pham-dich-vu/internet-fpt/cap-quang-doanh-nghiep?utm_source=chatgpt.com)) 

Nếu anh gửi em **model router đang nối FPT**, ví dụ MikroTik/TP-Link/DrayTek/UniFi, em chỉ anh từng bước để map **`118.69.40.112 → 192.168.2.159`**.

---

> ### 👤 User · 2026-09-16 15:53:35
>
> Còn 
>
> | <br>IP Address | 118.69.78.15 |
> | -------------- | ------------ |

---

### 🤖 ChatGPT `gpt-5-6-thinking` · 2026-09-16 15:53:43

`118.69.78.15` là **IP Front / IP WAN chính của đường truyền FPT** anh.

Nó khác nhóm IP Route:

```text
IP Front:
118.69.78.15

IP Route:
118.69.40.112
118.69.40.113
118.69.40.114
118.69.40.115
```

Mô hình hiểu đơn giản:

```text
Internet
 │
FPT
 │
118.69.78.15 ← IP Front/WAN
 │
Router/Firewall
 │
 ├── 118.69.40.112 → Server 1
 ├── 118.69.40.113 → Server 2
 ├── 118.69.40.114 → Server 3
 └── 118.69.40.115 → Server 4
```

### `118.69.78.15` dùng để làm gì?

Thông thường IP này nằm ở **cổng WAN của modem/router**, không phải IP anh đem gán trực tiếp cho một PC phía LAN.

Ví dụ:

```text
Router WAN
Public IP: 118.69.78.15
```

Còn các máy:

```text
PC1 → Public 118.69.40.112
PC2 → Public 118.69.40.113
PC3 → Public 118.69.40.114
PC4 → Public 118.69.40.115
```

### IP Front có dùng để chạy server được không?

**Có thể**, ví dụ port forward:

```text
118.69.78.15:443
 ↓
192.168.2.159:443
```

Nhưng em không khuyên dùng IP Front cho server nếu anh đã mua thêm IP Route.

Tốt hơn là:

```text
118.69.78.15
→ dành cho WAN/router

118.69.40.112-115
→ dành cho các server
```

Như vậy quản lý sạch hơn và mỗi server có Public IP riêng.

Nếu hiện tại PC Ubuntu của anh là `192.168.2.159`, cấu hình cuối cùng có thể là:

```text
FPT WAN: 118.69.78.15

Server Ubuntu:
LAN: 192.168.2.159
Public NAT: 118.69.40.112
```

Khi Ubuntu truy cập Internet, nếu cấu hình **1:1 NAT đúng**, website kiểm tra IP sẽ thấy:

```text
118.69.40.112
```

chứ không phải `118.69.78.15`.

Nếu anh muốn, bước tiếp theo em có thể hướng dẫn luôn **từ modem FPT → map `118.69.40.112` vào máy Ubuntu `192.168.2.159`**.

---


*19 messages · 40 nodes*
