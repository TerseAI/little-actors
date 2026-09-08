mod service;
mod wire;

pub(crate) mod proto {
    tonic::include_proto!("little_actors.v1");
}

pub(crate) use self::service::ActorHostGrpcService;
