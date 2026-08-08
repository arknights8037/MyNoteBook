fn main() {
    if my_notebook_lib::core_server::is_headless_core_process() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("create Headless Core runtime");
        if let Err(error) = runtime.block_on(my_notebook_lib::core_server::run_from_process_args())
        {
            eprintln!("Headless Core 启动失败：{error}");
            std::process::exit(1);
        }
    } else {
        my_notebook_lib::run()
    }
}
