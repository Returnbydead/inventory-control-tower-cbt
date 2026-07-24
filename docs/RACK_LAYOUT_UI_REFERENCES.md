# Rack Layout UI References

Tanggal riset: 23 Juli 2026

Tujuan dokumen ini adalah mencari pola visual yang membuat peta warehouse dan
rack mudah dibaca oleh operator. Referensi diprioritaskan dari halaman produk
atau dokumentasi resmi, bukan artikel opini.

## Kesimpulan utama

Prototype berikutnya sebaiknya tidak memakai perspektif 3D sebagai tampilan
utama. Pola yang paling konsisten dari referensi adalah:

1. Mulai dari **top-down 2D floorplan** agar hubungan zone, Aisle, dock, staging,
   dan arah perjalanan tetap terbaca.
2. Pertahankan hierarchy lokasi:
   **Warehouse > Floor > Zone > Aisle > Rack/Side > Bay > Level > SLOC**.
3. Setelah Aisle dipilih, buka **rack elevation ortografis** (tampak depan),
   bukan camera perspective. Bentuk rack harus memperlihatkan upright, beam,
   bay, level, serta Side A/B.
4. 3D hanya menjadi mode konteks atau walkthrough, bukan cara utama membaca
   ribuan status lokasi.
5. Gunakan satu metric overlay pada satu waktu. Struktur rack tetap netral,
   sedangkan status ditaruh di slot sebagai fill, border, badge, atau heatmap.

## Referensi dan pola yang dapat dipakai

### 1. Dynaflow — live warehouse map

Sumber resmi:
[Warehouse Digital Twin](https://dynaflow.de/ops/digital-twin.html)

Halaman ini secara eksplisit menggambarkan digital twin sebagai **top-down 2D
view** yang memetakan setiap zone, Aisle, shelf location, packing station,
inbound, dan shipping dock.

Pola yang dapat diadopsi:

- floorplan utama berbentuk top-down, bukan sudut isometric;
- rack rows harus tetap berada di dalam konteks landmark operasional;
- label zone ditempatkan langsung pada bidang peta;
- user memperoleh orientasi melalui bentuk fisik warehouse sebelum melihat
  status inventory.

Implikasi untuk CBT: overview harus mengikuti footprint PDF warehouse dan
menunjukkan SPR, mezzanine, High Value, staging, serta jalur Aisle sebagai ruang
kosong yang jelas.

### 2. WareBee — layout designer dan spatial analysis

Sumber resmi:
[Visualise Warehouse](https://warebee.com/digital-twin/visualize/)

WareBee memisahkan **layout structure** dari **stock/analysis overlay**. Halaman
produknya menyebut floors, Aisle types, access limitations, racking profiles,
drag-and-drop layout, Aisle and bay editor, stock positions, serta occupancy
heatmaps.

Pola yang dapat diadopsi:

- bentuk rack berasal dari racking profile, bukan dari nilai metrik;
- Aisle dan bay adalah objek navigasi yang eksplisit;
- metric seperti occupancy atau category compliance ditambahkan sebagai
  overlay;
- layout editor/model dan analytical view memakai geometri fisik yang sama.

Implikasi untuk CBT: tinggi balok 3D tidak boleh mewakili quantity atau value.
Semua rack memiliki ukuran fisik konsisten; warna slot yang membawa metrik.

### 3. CannonWMS — floorplan to rack/bin drilldown

Sumber resmi:
[Floor Plan Editor](https://shipcannon.com/demos/floor-plans/)

Walkthrough resminya menunjukkan urutan floor plan list, canvas, rack/zone
placement, **rack detail and bin layout**, inventory overlay, lalu view mode.
Canvas memakai grid skala warehouse, toolbar select/draw/zoom, dan sidebar
template rack serta zone.

Pola yang dapat diadopsi:

- overview dan bin layout adalah dua level visual berbeda;
- klik rack membuka detail internalnya;
- rack template membedakan pallet rack, flow rack, shelving, dan bin organizer;
- zoom/select adalah kontrol permanen, bukan interaksi tersembunyi.

Implikasi untuk CBT: klik Aisle membuka daftar rack Side A/B; klik rack membuka
elevation berisi bay x level. Jangan mencoba menampilkan label setiap SLOC saat
overview.

### 4. Autodesk Factory Design Utilities — synchronized 2D and 3D

Sumber resmi:
[Factory Design Utilities Overview](https://help.autodesk.com/cloudhelp/2025/ENU/FDU/files/About-Factory-Design-Utilities/FDU_About_Factory_Design_Utilities_Factory_Design_Utilities_Overview_html.html)

Autodesk menggunakan asosiasi dua arah antara layout 2D dan model 3D. Asset 3D
diletakkan di atas counterpart 2D yang sama, sehingga berpindah mode tidak
mengubah posisi atau identitas objek.

Pola yang dapat diadopsi:

- tombol 2D/3D harus mempertahankan selection, camera target, dan metric;
- objek rack mempunyai satu ID dan footprint yang sama di kedua mode;
- 3D menambah pemahaman bentuk/tinggi, bukan mengubah representasi data.

Implikasi untuk CBT: jika user memilih `MZD3 > Aisle 12`, switch ke 3D harus
tetap fokus ke Aisle 12, bukan me-reset ke seluruh warehouse.

### 5. ArcGIS Indoors — floor-aware navigation

Sumber resmi:
[Prepare a scene for Indoors Viewer](https://doc.arcgis.com/en/indoors/latest/viewer/prepare-a-scene-for-indoor-viewer.htm)

Dokumentasi ArcGIS menggunakan floor filter dan menawarkan pilihan untuk
menampilkan hanya floor terpilih atau floor terpilih beserta lantai di bawahnya.
Scene harus floor-aware agar hierarchy vertikal tidak ambigu.

Pola yang dapat diadopsi:

- floor adalah filter utama dan selalu terlihat;
- default operasional menampilkan satu floor;
- floor lain dapat muncul redup sebagai konteks bila dibutuhkan;
- jangan menumpuk semua mezzanine/floor secara opaque.

Implikasi untuk CBT: MZE1 dan MZE2 tidak boleh terlihat seperti dua zone yang
berdampingan. UI harus menunjukkan bahwa keduanya berada pada elevasi berbeda.

### 6. Sandhed — real floorplan, zones, snapping, and status overlays

Sumber resmi:
[Floor Plan Visualization for Warehousing](https://www.sandhed.com/solutions/floor-plan-visualization/warehousing)

Sandhed memulai dari PDF/PNG/JPEG floor plan, men-trace zone, menambahkan rack
dan asset pada lokasi riil, memakai snapping, serta menaruh status sebagai
color-coded overlay. Halamannya juga menyebut floor markings seperti forklift
lane, pedestrian crossing, parking, dan keep-clear zone.

Pola yang dapat diadopsi:

- gunakan PDF warehouse sebagai spatial underlay/reference;
- tampilkan jalur forklift dan ruang bebas sebagai elemen orientasi;
- status adalah overlay pada objek fisik;
- asset menempel pada zone/koordinat yang stabil.

Implikasi untuk CBT: denah tidak cukup hanya berisi kumpulan rectangle rack.
Jalur Aisle, perimeter, column/landmark penting, dan label area harus ikut
tergambar.

### 7. IntralogisticGrid — distinct 2D, 3D, and first-person purposes

Sumber resmi:
[Warehouse Planning and 3D Design](https://www.intralogisticgrid.com/)

Produk ini memisahkan 2D floor plan untuk desain presisi, 3D visualization
untuk hubungan spasial, dan first-person walkthrough untuk pengalaman alur
fisik.

Pola yang dapat diadopsi:

- mode visual harus mempunyai tujuan yang jelas;
- 2D = mencari dan membandingkan;
- rack elevation = mengaudit slot;
- 3D/walkthrough = memahami bentuk dan orientasi fisik.

Implikasi untuk CBT: jangan membuat satu canvas 3D menanggung seluruh tugas
overview, analisis, pencarian SKU, dan audit SLOC sekaligus.

## Rancangan visibility yang direkomendasikan

### Level 1 — Warehouse/Floor map

- top-down 2D;
- footprint asli warehouse;
- rack row digambar sebagai footprint tipis dan konsisten;
- ruang Aisle lebih dominan daripada garis dekoratif;
- label di kedua ujung Aisle, misalnya `Aisle 03`;
- arah `INBOUND`, `OUTBOUND`, dan North/reference direction terlihat;
- hanya zone label dan summary badge yang muncul pada zoom awal.

### Level 2 — Zone/Aisle map

- Aisle terpilih berada di tengah;
- dua rack face dipisahkan oleh koridor:
  `Side A | Aisle 03 | Side B`;
- bay number berjalan dalam satu arah yang ditandai arrow;
- mini-map menunjukkan posisi Aisle terhadap warehouse;
- Aisle lain diredupkan, bukan dihilangkan sepenuhnya.

### Level 3 — Rack elevation

- tampak depan ortografis tanpa perspective distortion;
- header: zone, Aisle, Side, rack range;
- kolom = Bay/Row location;
- baris = Level (`L1`, `L2`, dan seterusnya);
- tiap slot memakai status border/fill;
- label lengkap muncul melalui hover/click, bukan ditulis semua sekaligus;
- selection membuka drawer SKU tanpa menutup rack.

Contoh orientasi:

```text
Bay direction 01 → 18

SIDE A        L5  [ ][ ][ ][ ][ ]
              L4  [ ][ ][ ][ ][ ]
              L3  [ ][ ][ ][ ][ ]
              L2  [ ][ ][ ][ ][ ]
              L1  [ ][ ][ ][ ][ ]
                   01 02 03 04 05

================ AISLE 03 ================

SIDE B        L5  [ ][ ][ ][ ][ ]
              L4  [ ][ ][ ][ ][ ]
              L3  [ ][ ][ ][ ][ ]
              L2  [ ][ ][ ][ ][ ]
              L1  [ ][ ][ ][ ][ ]
                   01 02 03 04 05
```

### Mode 3D

- gunakan camera isometric ringan atau eye-level Aisle;
- upright, beam, pallet, dan slot harus terlihat sebagai rack nyata;
- lantai dan Aisle markings dipertahankan;
- metric tetap berupa overlay slot;
- tombol `Reset orientation` dan `Back to 2D` selalu tersedia;
- jangan gunakan extruded columns atau ketinggian sebagai chart.

## Sistem label lokasi

Lokasi `CBT-MZE1-03-05-L2-05` sebaiknya diurai di panel dan breadcrumb:

```text
CBT / MZE1 / Aisle 03 / Bay 05 / Level 2 / Slot 05
```

Kode mentah tetap ditampilkan untuk pencarian/copy, tetapi label visual memakai
bahasa lokasi fisik. Karena master rack yang tersedia belum memastikan field
Side A/B secara eksplisit, Side tidak boleh diinferensikan tanpa mapping atau
aturan arah rack yang tervalidasi.

## Aturan warna dan legend

- struktur rack: steel blue/gray netral;
- beam: orange industrial tipis;
- compliant: green;
- mismatch: red;
- warning/mixed: amber;
- empty: white/light gray dengan outline;
- excluded/non-halal: purple hatch atau border, bukan fill solid yang mudah
  disalahartikan sebagai masalah;
- selected: blue outline tebal yang tidak bentrok dengan status fill.

Hanya satu metric aktif per view: `L1 Accuracy`, `Wrong Value`, `Wrong Qty`,
`Occupancy`, atau `L2 Visibility`. Legend selalu menempel pada map.

## Hal yang harus dihindari

- seluruh warehouse dipaksa menjadi 3D pada overview;
- rack berubah menjadi menara berdasarkan quantity/value;
- label SLOC muncul sekaligus pada zoom warehouse;
- Aisle hanya berupa gap tanpa nama dan arah;
- Side A/B ditebak dari urutan data;
- warna status menggantikan geometri fisik;
- perpindahan 2D/3D me-reset lokasi pilihan;
- semua floor/mezzanine ditumpuk dalam satu bidang.

## Arah prototype selanjutnya

Prototype yang paling tepat untuk diuji lebih dulu:

1. light-mode top-down floorplan mengikuti satu potongan layout asli;
2. floor selector dan breadcrumb;
3. click satu Aisle untuk membuka tampilan `Side A | corridor | Side B`;
4. click rack untuk membuka elevation bay x level;
5. toggle metric dengan legend yang konsisten;
6. 3D rack realistis menjadi optional preview setelah hierarchy 2D terbukti
   mudah dibaca.

