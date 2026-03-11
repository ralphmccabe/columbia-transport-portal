-- 1. Setup Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Create Tables
CREATE TABLE IF NOT EXISTS public.drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID REFERENCES public.drivers(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    status TEXT DEFAULT 'IN_PROGRESS',
    invoice_number TEXT,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS public.loads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id TEXT, -- session ID from tablet (changed from UUID for compatibility)
    invoice_number TEXT,
    billed_to TEXT,
    billed_addr TEXT,
    origin TEXT,
    destination TEXT,
    total_amount DECIMAL(10,2),
    items TEXT,
    truck_number TEXT,
    trailer_number TEXT,
    delivery_date TEXT,
    billing_terms TEXT,
    notes TEXT,
    pdf_url TEXT, -- Link to storage bucket
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    load_id UUID REFERENCES public.loads(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL, -- Path in storage bucket
    file_name TEXT NOT NULL,
    type TEXT NOT NULL, -- image/pdf/text
    label TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.gps_pings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id TEXT, -- session ID from tablet
    driver_name TEXT,
    truck_number TEXT,
    lat DECIMAL(10, 8),
    lng DECIMAL(11, 8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Enable Row Level Security with Open Policies
-- (Allows the app's anonymous key to read/write data)

ALTER TABLE public.loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gps_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

-- Allow anyone with the anon key to INSERT loads
CREATE POLICY "allow_anon_insert_loads" ON public.loads
  FOR INSERT TO anon WITH CHECK (true);

-- Allow anyone with the anon key to SELECT loads
CREATE POLICY "allow_anon_select_loads" ON public.loads
  FOR SELECT TO anon USING (true);

-- Allow anyone with the anon key to INSERT gps_pings
CREATE POLICY "allow_anon_insert_gps" ON public.gps_pings
  FOR INSERT TO anon WITH CHECK (true);

-- Allow anyone with the anon key to SELECT gps_pings
CREATE POLICY "allow_anon_select_gps" ON public.gps_pings
  FOR SELECT TO anon USING (true);

CREATE TABLE IF NOT EXISTS public.driver_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_name TEXT NOT NULL,
    truck_number TEXT,
    status TEXT NOT NULL,
    odometer INTEGER,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.driver_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_anon_insert_logs" ON public.driver_logs
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "allow_anon_select_logs" ON public.driver_logs
  FOR SELECT TO anon USING (true);

-- 4. Document Transfers Table
CREATE TABLE IF NOT EXISTS public.document_transfers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.document_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_anon_insert_transfers" ON public.document_transfers
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "allow_anon_select_transfers" ON public.document_transfers
  FOR SELECT TO anon USING (true);

-- 5. Reload Schema Cache (Fixes "Table not found" errors)
NOTIFY pgrst, 'reload schema';
